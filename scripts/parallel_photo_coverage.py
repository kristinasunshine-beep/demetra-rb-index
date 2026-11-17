#!/usr/bin/env python3
"""Bounded concurrent photo lookup with a durable candidate cache.

Up to eight independent lookups, at most two requests per source host. Public
catalogue changes remain serialized, exact-name checked and transactional.
"""
from __future__ import annotations
import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import copy
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
import hashlib
from io import BytesIO
import json
import os
import random
import re
from pathlib import Path
import threading
import time
from urllib.parse import urlsplit
from urllib.robotparser import RobotFileParser
from PIL import Image, UnidentifiedImageError

import full_photo_coverage as core
import volentis_photo_catalog
import willaert_photo_catalog
import vannucci_photo_catalog
from update_photos import PhotoError, DEFAULT_LIMITS, check_url, fetch_resource, to_jpeg, commit_files, identity_matches

DYNAMIC_PROVIDERS = {'volentis': volentis_photo_catalog, 'willaert': willaert_photo_catalog,
                     'vannucci-piante': vannucci_photo_catalog}


def lookup_names(plant, config):
    """Only the catalogue name and explicitly evidenced full-name aliases."""
    return list(dict.fromkeys([plant['latinName']] + [a['name'] for a in
        config.get('exactNameAliases', {}).get(plant['id'], [])
        if a.get('name') and a.get('evidenceUrls') and not a.get('manualPhotoOnly')]))


def lookup_plan(plant, offers, generic, policies, names, providers=None):
    """All supplying nursery lookups precede any other offer nursery."""
    providers = DYNAMIC_PROVIDERS if providers is None else providers
    own = {o['nurseryId'] for o in offers if o['plantId'] == plant['id'] and
           o.get('recordStatus') not in core.INACTIVE}
    dynamic = []
    for nid, module in providers.items():
        policy = policies.get(nid)
        if not policy or not module.PAGE_HOSTS <= set(policy['pageHosts']) or not module.IMAGE_HOSTS <= set(policy['imageHosts']):
            continue
        for name in names:
            dynamic.append({'kind': 'dynamic', 'nurseryId': nid, 'name': name,
                            'pageUrl': module.search_url(name), 'tier': 0 if nid in own else 1})
    return ([item for item in generic if item['tier'] == 0] +
            [item for item in dynamic if item['tier'] == 0] +
            [item for item in dynamic if item['tier'] != 0] +
            [item for item in generic if item['tier'] != 0])


class DynamicCatalogues:
    """Read-only adapter with once-per-session, fail-closed robots checks."""
    def __init__(self, session, policies, index, providers=None):
        self.session, self.policies, self.index = session, policies, index
        self.providers = DYNAMIC_PROVIDERS if providers is None else providers
        self.lock = threading.Lock()
        self.robot_locks, self.robot_results, self.fetchers = {}, {}, {}

    def fetcher_for(self, nursery_id):
        with self.lock:
            if nursery_id not in self.fetchers:
                def get(url, **kwargs):
                    policy = self.policies[nursery_id]
                    # Module endpoint hosts never extend the approved policy.
                    check_url(url, policy['pageHosts'])
                    kwargs['hosts'] = policy['pageHosts']
                    return self.session.get(url, **kwargs)
                self.fetchers[nursery_id] = get
            return self.fetchers[nursery_id]

    def robots(self, nursery_id, host):
        key = (nursery_id, host)
        with self.lock:
            guard = self.robot_locks.setdefault(key, threading.Lock())
        with guard:
            if key in self.robot_results:
                value = self.robot_results[key]
                if isinstance(value, Exception):
                    raise value
                return value
            known = self.index.get('nurseries', {}).get(nursery_id, {}).get('robots', {})
            if host in known and isinstance(known[host], (str, list)):
                rules = known[host]
            else:
                try:
                    response = self.session.get('https://' + host + '/robots.txt',
                        hosts=self.policies[nursery_id]['pageHosts'], max_bytes=512_000,
                        timeout=15, kind='page')
                    rules = response.body.decode('utf-8', 'replace').splitlines()
                except core.Exhausted:
                    raise
                except PhotoError as exc:
                    if exc.code == 'http_error' and 'HTTP 404' in str(exc):
                        rules = []
                    else:
                        self.robot_results[key] = exc
                        raise
            self.robot_results[key] = rules
            return rules

    def find(self, plant, item):
        nid, name = item['nurseryId'], item['name']
        policy = self.policies.get(nid)
        module = self.providers.get(nid)
        if not policy or not module or not module.PAGE_HOSTS <= set(policy['pageHosts']) or not module.IMAGE_HOSTS <= set(policy['imageHosts']):
            raise PhotoError('outside_offer_nurseries', 'Dynamic catalogue is not configured for this offer nursery.')
        host = urlsplit(module.search_url(name)).hostname
        rules = self.robots(nid, host)
        if nid=='willaert':
            robot=RobotFileParser(); robot.parse(rules.splitlines() if isinstance(rules,str) else rules)
            delay=robot.crawl_delay('DemetraPhotoBot') or 0
            rate=robot.request_rate('DemetraPhotoBot')
            if rate and rate.requests>0:delay=max(delay,rate.seconds/rate.requests)
            self.session.set_host_interval(host,delay)
        rows = module.candidates(name, fetcher=self.fetcher_for(nid), robots_rules=rules)
        result = []
        for row in rows:
            evidence = row.get('identityEvidence') or {}
            if row.get('nurseryId') != nid or row.get('matchedName') != name or not identity_matches(evidence.get('name'), name):
                raise PhotoError('identity_missing', 'Dynamic photograph lacks the exact full botanical name.')
            candidate = {**row, 'provider': 'supplying_nursery' if item['tier'] == 0 else 'other_catalogue_nursery',
                         'canonicalName': plant['latinName'],
                         'identityEvidence': {**evidence, 'canonicalName': plant['latinName']},
                         'imageHosts': policy['imageHosts'], 'imagePathPrefixes': policy.get('imagePathPrefixes'),
                         'license': 'existing_catalogue_source_policy'}
            if not core.candidate_allowed(candidate, self.policies):
                raise PhotoError('outside_offer_nurseries', 'Dynamic photograph is outside the configured nursery hosts.')
            result.append(candidate)
        return result


def error_record(source, exc):
    """Keep the actual failed URL/status, not an invented failure for each plant."""
    record={'source':getattr(exc,'source_url',source),'reason':getattr(exc,'code','source_error'),
            'detail':str(exc)[:500]}
    status=getattr(exc,'http_status',None)
    if status is not None:record['httpStatus']=status
    if record['source']!=source:record['requestedSource']=source
    if getattr(exc,'source_failure_cached',False):record['sourceUnavailable']=True
    return record


def http_status(exc):
    cause=getattr(exc,'__cause__',None)
    status=getattr(cause,'code',None)
    if isinstance(status,int):return status
    match=re.search(r'\bHTTP (\d{3})\b',str(exc))
    return int(match.group(1)) if match else None


def retry_after_seconds(exc, now=None):
    headers=getattr(getattr(exc,'__cause__',None),'headers',None)
    value=headers.get('Retry-After') if headers else None
    if value is None:return None
    try:
        seconds=float(value)
    except (TypeError,ValueError):
        try:seconds=parsedate_to_datetime(value).timestamp()-(time.time() if now is None else now)
        except (TypeError,ValueError,OverflowError):return None
    return max(0,seconds) if seconds<float('inf') else None


class ParallelSession:
    def __init__(self,budget,seconds,fetcher=fetch_resource,*,clock=time.monotonic,sleeper=time.sleep,jitter=None):
        self.clock=clock; self.sleeper=sleeper; self.jitter=jitter or (lambda:random.uniform(0,0.25))
        self.budget=budget; self.deadline=clock()+seconds; self.requests=0
        self.fetcher=fetcher; self.lock=threading.Lock(); self.hosts={}; self.failed={}; self.cache={}
        self.last_request={}; self.source_health={}; self.host_intervals={}

    def set_host_interval(self,host,seconds):
        with self.lock:self.host_intervals[host]=max(self.host_intervals.get(host,0),seconds)

    def _pause(self,seconds):
        if seconds<=0:return
        if self.clock()+seconds>=self.deadline:
            raise core.Exhausted('budget_exhausted','Source cooldown exceeds the remaining time; resume next run.')
        self.sleeper(seconds)

    def _cached_failure(self,host):
        original=self.failed[host]
        exc=PhotoError('source_unavailable','No new request: source stopped after '+str(original))
        exc.source_url=getattr(original,'source_url','https://'+host+'/')
        exc.http_status=getattr(original,'http_status',None)
        exc.source_failure_cached=True
        return exc

    def get(self,url,**kwargs):
        check_url(url,kwargs['hosts'],kwargs.get('path_prefixes'))
        host=urlsplit(url).hostname
        paced=host in willaert_photo_catalog.PAGE_HOSTS
        with self.lock:
            semaphore=self.hosts.setdefault(host,threading.Semaphore(1 if paced else 2))
        with semaphore:
            with self.lock:
                if url in self.cache:return self.cache[url]
                if host in self.failed:raise self._cached_failure(host)
                health=self.source_health.setdefault(host,{'requests':0,'succeeded':0,'retries':0,'httpErrors':{},'stopped':False})
                interval=max(willaert_photo_catalog.REQUEST_INTERVAL_SECONDS,self.host_intervals.get(host,0)) if paced else 0
                if paced:health['requestIntervalSeconds']=interval
            attempts=willaert_photo_catalog.TRANSIENT_MAX_ATTEMPTS if paced else 1
            for attempt in range(attempts):
                if paced:
                    self._pause(max(0,self.last_request.get(host,-float('inf'))+interval-self.clock()))
                with self.lock:
                    if self.requests>=self.budget or self.clock()>=self.deadline:
                        raise core.Exhausted('budget_exhausted','Saved candidates resume on the next run.')
                    self.requests+=1; health['requests']+=1; self.last_request[host]=self.clock()
                request_args={**kwargs,'timeout':min(kwargs['timeout'],max(1,int(self.deadline-self.clock())))}
                try:
                    result=self.fetcher(url,**request_args)
                    check_url(result.url,kwargs['hosts'],kwargs.get('path_prefixes'))
                    if len(result.body)>kwargs['max_bytes']:raise PhotoError('response_too_large','Oversize response.')
                    if kwargs['kind']=='page' and result.content_type in ('text/html','application/xhtml+xml') and core.blocked_html(result.body.decode('utf8','replace')):
                        raise PhotoError('site_blocked','Source refused access.')
                    with self.lock:
                        self.cache[url]=result; health['succeeded']+=1
                    return result
                except PhotoError as exc:
                    status=http_status(exc)
                    exc.source_url=url; exc.http_status=status
                    with self.lock:
                        if status is not None:health['httpErrors'][str(status)]=health['httpErrors'].get(str(status),0)+1
                        health['lastFailure']=error_record(url,exc)
                    wait=retry_after_seconds(exc)
                    # Never retry access denial. A 429 requires the source's
                    # explicit Retry-After; long waits defer to the next run.
                    transient=status in (500,502,503,504) or (status==429 and wait is not None)
                    can_retry=(paced and transient and attempt+1<attempts and
                               (wait is None or wait<=willaert_photo_catalog.MAX_RETRY_AFTER_SECONDS))
                    if can_retry:
                        with self.lock:
                            if self.requests>=self.budget:
                                raise core.Exhausted('budget_exhausted','Request budget ended before a source retry; resume next run.')
                        delay=max(wait or 0,2**attempt)+self.jitter()
                        self._pause(delay)
                        with self.lock:health['retries']+=1
                        continue
                    if exc.code in ('download_failed','site_blocked') or status in (403,429,503) or (paced and transient):
                        with self.lock:self.failed[host]=exc; health['stopped']=True
                    raise


def run(root,*,workers=8,request_budget=2500,max_seconds=1200,cache_dir=None,fetcher=fetch_resource,plant_ids=None):
    if not 1<=workers<=8:raise ValueError('workers must be between 1 and 8')
    if not 0<=request_budget<=20000 or not 1<=max_seconds<=7200:raise ValueError('Invalid bounded request/time budget')
    root=Path(root).resolve()
    cache_dir=Path(cache_dir or Path(os.environ.get('RUNNER_TEMP',str(root.parent)))/'demetra-photo-cache')
    cache_dir.mkdir(parents=True,exist_ok=True)
    core.run(root,audit_only=True)
    data=core.read(root,'data/biljke.json'); before=copy.deepcopy(data)
    plants=data['plants']; offers=core.read(root,'data/kataloske-stavke.json')['offers']
    config=core.read(root,'scripts/full-photo-policy.json')
    policies=core.allowed_policies(root)
    index=core.read(root,'docs/photo-discovery-state.json',{'nurseries':{}})
    for row in config.get('observedPages',[]):
        pages=index['nurseries'].setdefault(row['nurseryId'],{'pages':[]})['pages']
        if row['pageUrl'] not in pages:pages.append(row['pageUrl'])
    genera={p['latinName'].split()[0].casefold() for p in plants}
    for item in index['nurseries'].values():
        item['_genusPages']={g:[] for g in genera}
        for page in item.get('pages',[]):
            tokens=set(core.re.findall(r'[^\W_]+',core.unquote(urlsplit(page).path).casefold()))
            for genus in genera&tokens:item['_genusPages'][genus].append(page)
    refs=core.read(root,'docs/photo-reference-catalog.json',{'references':[]})['references']
    manifest=core.read(root,core.MANIFEST); state=core.read(root,core.STATE)
    taxon_keys=core.taxonomy_keys(plants,config)
    original={name:(root/name).read_bytes() if (root/name).exists() else None for name in core.INPUTS}
    session=ParallelSession(request_budget,max_seconds,fetcher)
    dynamic=DynamicCatalogues(session,policies,index)
    pending={}; events=[]
    # Workers only read this snapshot. New cross-worker conflicts are checked
    # again by the serialized store below, before any catalogue mutation.
    known_taxa_by_hash={}
    for record in manifest['plants'].values():
        if record.get('sha256'):
            known_taxa_by_hash.setdefault(record['sha256'],set()).add(record.get('taxonKey',record.get('latinName')))

    def validate_candidate_bytes(plant,candidate,body):
        if not core.candidate_allowed(candidate,policies):raise PhotoError('outside_offer_nurseries','Only offer nursery photographs are accepted.')
        if candidate.get('matchedName') not in lookup_names(plant,config):raise PhotoError('identity_missing','Only the exact catalogue name or documented full alias is accepted.')
        if candidate.get('imageUrl') in manifest.get('excludedImageUrls',[]):raise PhotoError('reviewed_image_exclusion','Reviewed image rejected.')
        sha=core.digest(body)
        if sha in manifest.get('excludedImageHashes',[]) or sha in manifest.get('ambiguousImages',{}):
            raise PhotoError('reviewed_image_exclusion','Rejected or ambiguous image cannot be cached.')
        if known_taxa_by_hash.get(sha,set())-{taxon_keys[plant['id']]}:
            raise PhotoError('image_identity_conflict','The same photo belongs to another full botanical name.')
        try:
            with Image.open(BytesIO(body)) as picture:
                if min(picture.size)<128:raise PhotoError('image_too_small','Photo is too small for the catalogue.')
                picture.verify()
        except (UnidentifiedImageError,OSError,ValueError) as exc:
            raise PhotoError('invalid_image','Cached photo is not a decodable raster image.') from exc

    def discard_cache(plant_id):
        for path in (cache_dir/(plant_id+'.json'),cache_dir/(plant_id+'.jpg')):
            path.unlink(missing_ok=True)

    def lookup(plant):
        names=lookup_names(plant,config)
        errors=[]
        meta_path=cache_dir/(plant['id']+'.json'); jpg_path=cache_dir/(plant['id']+'.jpg')
        if meta_path.exists() and jpg_path.exists():
            try:
                cached=json.loads(meta_path.read_text(encoding='utf8')); body=jpg_path.read_bytes()
                if not plant.get('photo') and cached.get('catalogueName')==plant['latinName'] and cached.get('sha256')==core.digest(body):
                    validate_candidate_bytes(plant,cached.get('candidate',{}),body)
                    return cached['candidate'],body,[]
            except (PhotoError,OSError,ValueError):
                discard_cache(plant['id'])
        def download(candidate):
            if not core.candidate_allowed(candidate,policies):raise PhotoError('outside_offer_nurseries','Only offer nursery photographs are accepted.')
            if candidate.get('matchedName') not in names:raise PhotoError('identity_missing','Only the exact catalogue name or documented full alias is accepted.')
            if candidate.get('imageUrl') in manifest.get('excludedImageUrls',[]):raise PhotoError('reviewed_image_exclusion','Reviewed image rejected.')
            response=session.get(candidate['imageUrl'],hosts=candidate['imageHosts'],path_prefixes=candidate.get('imagePathPrefixes'),max_bytes=DEFAULT_LIMITS['maxImageBytes'],timeout=15,kind='image')
            if response.content_type not in ('image/jpeg','image/png','image/webp','image/avif','image/gif'):raise PhotoError('invalid_image','Not a raster image.')
            body=to_jpeg(response.body,DEFAULT_LIMITS)
            validate_candidate_bytes(plant,candidate,body)
            candidate['taxonKey']=taxon_keys[plant['id']]
            commit_files({jpg_path:body,meta_path:core.encoded({'catalogueName':plant['latinName'],'sha256':core.digest(body),'candidate':candidate})})
            return candidate,body,errors
        entry=state['plants'][plant['id']]
        candidates=lookup_plan(plant,offers,core.candidates_for(plant,offers,refs,policies,index,names),policies,names)
        if plant.get('photo'):
            record=manifest['plants'][plant['id']]
            candidates=[{'nurseryId':record['nurseryId'],'pageUrl':record['sourceUrl'],'tier':0}]+[c for c in candidates if c['pageUrl']!=record['sourceUrl']]
        fingerprint=core.digest(core.encoded(candidates))
        start=entry.get('nextCandidate',0) if entry.get('fingerprint')==fingerprint else 0
        if start>=len(candidates):start=0
        entry['fingerprint']=fingerprint
        stop=min(len(candidates),start+30)
        for pos in range(start,stop):
            item=candidates[pos]
            # Preserve this item if the shared request/time budget ends midway.
            entry['nextCandidate']=pos
            try:
                if item.get('kind')=='dynamic':
                    for candidate in dynamic.find(plant,item)[:6]:
                        try:
                            result=download(candidate)
                            return result
                        except PhotoError as exc:
                            if isinstance(exc,core.Exhausted):raise
                            errors.append(error_record(candidate['sourceUrl'],exc))
                    entry['nextCandidate']=pos+1
                    continue
                excluded=set(manifest.get('excludedImageUrls',[]))
                # A rejected main photo does not invalidate every other photo
                # of this exact product. Reuse the cached page, keep all source
                # and full-cultivar checks, and try only a bounded set of images.
                for attempt in range(6):
                    candidate=core.nursery_candidate(plant,item,policies[item['nurseryId']],index,session,names,
                                                     excluded_images=excluded)
                    try:
                        result=download(candidate)
                        return result
                    except PhotoError as exc:
                        if exc.code not in ('reviewed_image_exclusion','invalid_image','invalid_image_type',
                                            'image_too_small','placeholder_image','image_identity_conflict'):
                            raise
                        excluded.add(candidate['imageUrl'])
                        errors.append(error_record(item['pageUrl'],exc))
                entry['nextCandidate']=pos+1
            except core.Exhausted:return None,None,errors+[{'reason':'budget_exhausted'}]
            except (PhotoError,OSError,ValueError) as exc:
                errors.append(error_record(item['pageUrl'],exc))
                entry['nextCandidate']=pos+1
        if stop==len(candidates):entry['nextCandidate']=0
        return None,None,errors

    from datetime import timedelta
    cutoff=(datetime.now(timezone.utc)-timedelta(days=config.get('refreshDays',30))).isoformat().replace('+00:00','Z')
    missing=sorted([p for p in plants if not p.get('photo') and (plant_ids is None or p['id'] in plant_ids)],key=lambda p:state['plants'][p['id']].get('checkedAt',''))
    refresh=sorted([p for p in plants if p.get('photo') and (plant_ids is None or p['id'] in plant_ids) and max(manifest['plants'][p['id']].get('checkedAt',''),state['plants'][p['id']].get('lastRefreshAttemptAt',''))<cutoff],key=lambda p:manifest['plants'][p['id']].get('checkedAt',''))[:config.get('refreshPerRun',20)]
    queue=refresh+missing
    print('Parallel photo search: '+str(len(missing))+' plants, '+str(workers)+' workers',flush=True)
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures={pool.submit(lookup,p):p for p in queue}
        for future in as_completed(futures):
            plant=futures[future]
            try:
                candidate,jpeg,errors=future.result()
                if candidate:
                    candidate['taxonKey']=taxon_keys[plant['id']]
                    core.store_jpeg(root,plant,candidate,jpeg,pending,manifest,policies)
                    state['plants'][plant['id']].pop('nextCandidate',None)
                    print('Foto: '+plant['latinName'],flush=True)
                if plant.get('photo'):state['plants'][plant['id']]['lastRefreshAttemptAt']=core.stamp()
                state['plants'][plant['id']].update(status='verified' if plant.get('photo') else 'pending',checkedAt=core.stamp(),failures=errors)
            except (PhotoError,OSError,ValueError,KeyError) as exc:
                # A concurrent lookup can discover a duplicate after another
                # worker has passed its snapshot check. Never let that durable
                # cache short-circuit the next search or discard its cursor.
                if getattr(exc,'code','') in ('image_identity_conflict','reviewed_image_exclusion',
                                              'image_too_small','invalid_image','asset_collision'):
                    discard_cache(plant['id'])
                events.append({'plantId':plant['id'],'reason':getattr(exc,'code','candidate_error'),'detail':str(exc)})
    for plant in plants:
        record=manifest['plants'].get(plant['id'],{})
        if plant.get('photo') and record.get('sha256') in manifest.get('ambiguousImages',{}):
            manifest.setdefault('retiredReferences',{})[plant['id']]=plant.pop('photo')
    core.protect(before,data)
    for name,body in original.items():
        if ((root/name).read_bytes() if (root/name).exists() else None)!=body:raise PhotoError('concurrent_edit','Catalogue changed during lookup: '+name)
    report={'schemaVersion':2,'status':'partial','requests':session.requests,'workers':workers,'events':events,
            'sourceHealth':session.source_health,'coverage':core.inventory(root,plants,offers,pending),'nonPhotoDataUnchanged':True}
    report['status']=report['coverage']['status']
    report['newlyVerified']=sum(bool(p.get('photo')) and not old.get('photo') for p,old in zip(plants,before['plants']))
    report['refreshCandidates']=len(refresh)
    pending.update({root/'data/biljke.json':core.encoded(data),root/core.MANIFEST:core.encoded(manifest),root/core.STATE:core.encoded(state),root/'docs/photo-coverage.json':core.encoded(report['coverage']),root/'docs/photo-pipeline-report.json':core.encoded(report)})
    commit_files(pending)
    # Fill newly available documented equivalent names and recheck all hashes.
    final=core.run(root,audit_only=True)
    report['coverage']=final['coverage']; report['status']=final['status']
    commit_files({root/'docs/photo-pipeline-report.json':core.encoded(report)})
    return report


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root',type=Path,default=Path(__file__).resolve().parents[1])
    parser.add_argument('--workers',type=int,default=8)
    parser.add_argument('--request-budget',type=int,default=2500)
    parser.add_argument('--max-seconds',type=int,default=1200)
    parser.add_argument('--report',type=Path)
    parser.add_argument('--targets',type=Path)
    args=parser.parse_args()
    selected=None
    if args.targets:
        selected={x if isinstance(x,str) else x['plantId'] for x in json.loads(args.targets.read_text(encoding='utf8'))}
    report=run(args.root,workers=args.workers,request_budget=args.request_budget,max_seconds=args.max_seconds,plant_ids=selected)
    if args.report:args.report.write_bytes(core.encoded(report))
    print(json.dumps({k:v for k,v in report['coverage'].items() if k!='plantsWithoutPhoto'},ensure_ascii=False,indent=2),flush=True)

if __name__=='__main__':main()
