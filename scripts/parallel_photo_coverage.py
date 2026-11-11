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
import hashlib
import json
import os
from pathlib import Path
import threading
import time
from urllib.parse import urlsplit

import full_photo_coverage as core
from update_photos import PhotoError, DEFAULT_LIMITS, check_url, fetch_resource, to_jpeg, commit_files


class ParallelSession:
    def __init__(self,budget,seconds,fetcher=fetch_resource):
        self.budget=budget; self.deadline=time.monotonic()+seconds; self.requests=0
        self.fetcher=fetcher; self.lock=threading.Lock(); self.hosts={}; self.failed={}; self.cache={}

    def get(self,url,**kwargs):
        check_url(url,kwargs['hosts'],kwargs.get('path_prefixes'))
        host=urlsplit(url).hostname
        with self.lock:
            semaphore=self.hosts.setdefault(host,threading.Semaphore(2))
        with semaphore:
            with self.lock:
                if url in self.cache:return self.cache[url]
                if host in self.failed:raise self.failed[host]
                if self.requests>=self.budget or time.monotonic()>=self.deadline:
                    raise core.Exhausted('budget_exhausted','Saved candidates resume on the next run.')
                self.requests+=1
            kwargs['timeout']=min(kwargs['timeout'],max(1,int(self.deadline-time.monotonic())))
            try:
                result=self.fetcher(url,**kwargs)
                check_url(result.url,kwargs['hosts'],kwargs.get('path_prefixes'))
                if len(result.body)>kwargs['max_bytes']:raise PhotoError('response_too_large','Oversize response.')
                if kwargs['kind']=='page' and result.content_type in ('text/html','application/xhtml+xml') and core.blocked_html(result.body.decode('utf8','replace')):
                    raise PhotoError('site_blocked','Source refused access.')
                with self.lock:self.cache[url]=result
                return result
            except PhotoError as exc:
                if exc.code in ('download_failed','site_blocked') or any(x in str(exc) for x in ('HTTP 403','HTTP 429','HTTP 503')):
                    with self.lock:self.failed[host]=exc
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
    pending={}; events=[]

    def lookup(plant):
        names=[plant['latinName']]+[a['name'] for a in config.get('exactNameAliases',{}).get(plant['id'],[]) if a.get('evidenceUrls')]
        errors=[]
        meta_path=cache_dir/(plant['id']+'.json'); jpg_path=cache_dir/(plant['id']+'.jpg')
        if meta_path.exists() and jpg_path.exists():
            cached=json.loads(meta_path.read_text(encoding='utf8')); body=jpg_path.read_bytes()
            if not plant.get('photo') and core.candidate_allowed(cached.get('candidate',{}),policies) and cached.get('catalogueName')==plant['latinName'] and cached.get('sha256')==core.digest(body) and cached['candidate'].get('matchedName') in names and cached['candidate'].get('imageUrl') not in manifest.get('excludedImageUrls',[]) and cached.get('sha256') not in manifest.get('excludedImageHashes',[]):
                return cached['candidate'],body,[]
        def download(candidate):
            if not core.candidate_allowed(candidate,policies):raise PhotoError('outside_offer_nurseries','Only offer nursery photographs are accepted.')
            if candidate.get('imageUrl') in manifest.get('excludedImageUrls',[]):raise PhotoError('reviewed_image_exclusion','Reviewed image rejected.')
            response=session.get(candidate['imageUrl'],hosts=candidate['imageHosts'],path_prefixes=candidate.get('imagePathPrefixes'),max_bytes=DEFAULT_LIMITS['maxImageBytes'],timeout=15,kind='image')
            if response.content_type not in ('image/jpeg','image/png','image/webp','image/avif','image/gif'):raise PhotoError('invalid_image','Not a raster image.')
            body=to_jpeg(response.body,DEFAULT_LIMITS)
            if core.digest(body) in manifest.get('excludedImageHashes',[]):raise PhotoError('reviewed_image_exclusion','Reviewed image rejected.')
            candidate['taxonKey']=taxon_keys[plant['id']]
            commit_files({jpg_path:body,meta_path:core.encoded({'catalogueName':plant['latinName'],'sha256':core.digest(body),'candidate':candidate})})
            return candidate,body,errors
        entry=state['plants'][plant['id']]
        candidates=core.candidates_for(plant,offers,refs,policies,index,names)
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
            try:
                result=download(core.nursery_candidate(plant,item,policies[item['nurseryId']],index,session,names))
                entry.pop('nextCandidate',None)
                return result
            except core.Exhausted:return None,None,errors+[{'reason':'budget_exhausted'}]
            except (PhotoError,OSError,ValueError) as exc:
                errors.append({'source':item['pageUrl'],'reason':getattr(exc,'code','source_error')})
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
                    print('Foto: '+plant['latinName'],flush=True)
                if plant.get('photo'):state['plants'][plant['id']]['lastRefreshAttemptAt']=core.stamp()
                state['plants'][plant['id']].update(status='verified' if plant.get('photo') else 'pending',checkedAt=core.stamp(),failures=errors)
            except (PhotoError,OSError,ValueError,KeyError) as exc:
                events.append({'plantId':plant['id'],'reason':getattr(exc,'code','candidate_error'),'detail':str(exc)})
    for plant in plants:
        record=manifest['plants'].get(plant['id'],{})
        if plant.get('photo') and record.get('sha256') in manifest.get('ambiguousImages',{}):
            manifest.setdefault('retiredReferences',{})[plant['id']]=plant.pop('photo')
    core.protect(before,data)
    for name,body in original.items():
        if ((root/name).read_bytes() if (root/name).exists() else None)!=body:raise PhotoError('concurrent_edit','Catalogue changed during lookup: '+name)
    report={'schemaVersion':2,'status':'partial','requests':session.requests,'workers':workers,'events':events,'coverage':core.inventory(root,plants,offers,pending),'nonPhotoDataUnchanged':True}
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
