"""Validate actual exported XLSX, including constraints ignored by tolerant JS readers."""
import sys
import re
import zipfile
import posixpath
import xml.etree.ElementTree as ET
from pathlib import Path

M = '{http://schemas.openxmlformats.org/spreadsheetml/2006/main}'
R = '{http://schemas.openxmlformats.org/officeDocument/2006/relationships}'
P = '{http://schemas.openxmlformats.org/package/2006/relationships}'

def column(name):
    n = 0
    for c in name:
        n = n * 26 + ord(c) - 64
    return n

def validate(path):
    with zipfile.ZipFile(path) as z:
        assert z.testzip() is None
        parsed = {n: ET.fromstring(z.read(n)) for n in z.namelist() if n.endswith(('.xml', '.rels'))}
        book = parsed['xl/workbook.xml']
        rels = {v.attrib['Id']: v.attrib['Target'] for v in parsed['xl/_rels/workbook.xml.rels']}
        ids = set()
        for sheet in book.find(M+'sheets'):
            sid = sheet.attrib['sheetId']
            assert sid not in ids, (path, 'duplicate sheetId', sid)
            ids.add(sid)
            target = rels[sheet.attrib[R+'id']]
            target = target.lstrip('/') if target.startswith('/') else posixpath.normpath('xl/'+target)
            ws = parsed[target]
            for name in ['sheetPr','dimension','sheetViews','sheetFormatPr','cols','sheetData','mergeCells','dataValidations','pageMargins','pageSetup','drawing']:
                assert len(ws.findall(M+name)) <= 1, (path,target,'duplicate element',name)
            pr = ws.find(M+'sheetPr')
            if pr is not None:
                assert len(pr.findall(M+'pageSetUpPr')) <= 1, (path,target,'duplicate pageSetUpPr')
            merged = ws.find(M+'mergeCells')
            occupied = set()
            if merged is not None:
                assert int(merged.attrib['count']) == len(merged)
                for merge in merged:
                    ref = merge.attrib['ref']
                    a,b,c,d = re.fullmatch(r'([A-Z]+)(\d+):([A-Z]+)(\d+)',ref).groups()
                    for row in range(int(b),int(d)+1):
                        for col in range(column(a),column(c)+1):
                            assert (row,col) not in occupied, (path,target,'overlapping merge',ref)
                            occupied.add((row,col))
            columns = ws.find(M+'cols')
            if columns is not None:
                end = 0
                for c in columns:
                    lo,hi = int(c.attrib['min']),int(c.attrib['max'])
                    assert end < lo <= hi, (path,target,'overlapping or unsorted columns',lo,hi)
                    end=hi
            prior_row=0
            for row in ws.find(M+'sheetData'):
                rid=int(row.attrib['r'])
                assert rid>prior_row,(path,target,'duplicate or unsorted row',rid)
                prior_row=rid
                prior_col=0
                for cell in row.findall(M+'c'):
                    col,number=re.fullmatch(r'([A-Z]+)(\d+)',cell.attrib['r']).groups()
                    assert int(number)==rid and column(col)>prior_col,(path,target,'invalid cell order',cell.attrib['r'])
                    prior_col=column(col)
        print(f'Validated XLSX package: {Path(path).name}, {len(ids)} sheets, all XML parsed; merges, columns and cell order valid.')

for path in sys.argv[1:]:
    validate(path)
