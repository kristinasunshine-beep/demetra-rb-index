(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.DemetraRecommendationExcel=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const xml=v=>String(v??'').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g,'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
  function col(index){let s='';for(let n=index+1;n;n=Math.floor((n-1)/26))s=String.fromCharCode(65+(n-1)%26)+s;return s;}
  function normalizeXml(s){const found=s.match(/xmlns:([\w]+)="(http:\/\/schemas\.openxmlformats\.org\/spreadsheetml\/2006\/main|http:\/\/purl\.oclc\.org\/ooxml\/spreadsheetml\/main)"/);if(!found)return s;const [,prefix,namespace]=found;return s.replace(found[0],s.includes(`xmlns="${namespace}"`)?'':`xmlns="${namespace}"`).replace(new RegExp('<(\\/?)'+prefix+':','g'),'<$1');}
  function cell(ref,value,style){const a=` r="${ref}" s="${style}"`;if(value===null||value===undefined||value==='')return `<c${a}/>`;if(value instanceof Date)return `<c${a}><v>${value.getTime()/86400000+25569}</v></c>`;if(typeof value==='number'&&Number.isFinite(value))return `<c${a}><v>${value}</v></c>`;if(typeof value==='boolean')return `<c${a} t="b"><v>${value?1:0}</v></c>`;return `<c${a} t="inlineStr"><is><t xml:space="preserve">${xml(value)}</t></is></c>`;}
  const attr=(s,name)=>s.match(new RegExp('(?:^|\\s)'+name+'="([^"]*)"'))?.[1];
  const decode=s=>String(s||'').replace(/&#(x[\da-f]+|\d+);|&(amp|lt|gt|quot|apos);/gi,(_,number,name)=>number?String.fromCodePoint(number[0].toLowerCase()==='x'?parseInt(number.slice(1),16):Number(number)):({amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"}[name]));
  function setAttr(tag,name,value){const re=new RegExp('\\s'+name+'="[^"]*"');return re.test(tag)?tag.replace(re,` ${name}="${xml(value)}"`):tag.replace(/(\/?>)/,` ${name}="${xml(value)}"$1`);}
  function collection(source,name,item){const body=source.match(new RegExp('<'+name+'\\b[^>]*>([\\s\\S]*?)<\\/'+name+'>'))?.[1]||'';return body.match(new RegExp('<'+item+'\\b[^>]*?(?:\\/>|>[\\s\\S]*?<\\/'+item+'>)','g'))||[];}
  function replaceCollection(source,name,items){const replacement=`<${name} count="${items.length}">${items.join('')}</${name}>`,re=new RegExp('<'+name+'\\b[^>]*?(?:\\/>|>[\\s\\S]*?<\\/'+name+'>)');if(re.test(source))return source.replace(re,replacement);if(name==='numFmts')return source.replace(/(<styleSheet\b[^>]*>)/,'$1'+replacement);throw new Error('Nedostaju Excel stilovi: '+name);}
  function copyResultStyles(source,seed,selected){
    let output=normalizeXml(source);seed=normalizeXml(seed);const offsets={};
    for(const [name,item] of [['fonts','font'],['fills','fill'],['borders','border']]){const current=collection(output,name,item);offsets[item+'Id']=current.length;output=replaceCollection(output,name,current.concat(collection(seed,name,item)));}
    const formats=collection(output,'numFmts','numFmt'),formatMap=new Map();let nextFormat=Math.max(163,...formats.map(v=>Number(attr(v,'numFmtId'))))+1;
    for(const format of collection(seed,'numFmts','numFmt')){const previous=attr(format,'numFmtId');formatMap.set(previous,nextFormat);formats.push(setAttr(format,'numFmtId',nextFormat++));}
    if(formats.length)output=replaceCollection(output,'numFmts',formats);
    const current=collection(output,'cellXfs','xf'),from=collection(seed,'cellXfs','xf'),mapped={};
    for(const [name,id] of Object.entries(selected)){let style=from[Number(id)];if(!style)throw new Error('Nedostaje stil Excel preporuke.');for(const [attribute,offset] of Object.entries(offsets))style=setAttr(style,attribute,Number(attr(style,attribute)||0)+offset);const oldFormat=attr(style,'numFmtId');if(formatMap.has(oldFormat))style=setAttr(style,'numFmtId',formatMap.get(oldFormat));style=setAttr(style,'xfId',0);style=setAttr(style,'applyProtection',1);style=style.replace(/<protection\b[^>]*\/>/g,'');style=/\/>$/.test(style)?style.replace(/\/>$/,'><protection locked="0"/></xf>'):style.replace(/<\/xf>$/,'<protection locked="0"/></xf>');mapped[name]=current.length;current.push(style);}
    return {xml:replaceCollection(output,'cellXfs',current),styles:mapped};
  }
  function resultWidth(offset){return [30,18,14,48,22,26,22,22,58][offset]||25;}
  function resolveSheetPath(target){const parts=(target.startsWith('/')?target.slice(1):'xl/'+target).split('/'),out=[];for(const part of parts){if(part==='..')out.pop();else if(part&&part!=='.')out.push(part);}return out.join('/');}
  function patchSheet(original,sheet,styles){
    let source=normalizeXml(original),existing=new Map(),lastRow=0;
    const dataMatch=source.match(/<sheetData\b[^>]*?(?:\/>|>([\s\S]*?)<\/sheetData>)/);
    if(!dataMatch)throw new Error('Excel list nema podatke za dopunu.');
    for(const row of (dataMatch[1]||'').match(/<row\b[^>]*?(?:\/>|>[\s\S]*?<\/row>)/g)||[]){const r=Number(attr(row,'r'))||lastRow+1;existing.set(r,row);lastRow=r;}
    for(let r=sheet.headerRow;r<sheet.rows.length;r++){
      const values=sheet.rows[r]||[];let cells='';
      for(let c=sheet.originalColumns;c<values.length;c++){const value=values[c];if(value===null||value===undefined||value==='')continue;const style=r===sheet.headerRow?styles.resultHeader:value instanceof Date?styles.date:c===sheet.originalColumns+1?styles.price:styles.text;cells+=cell(col(c)+(r+1),value,style);}
      if(!cells)continue;
      let row=existing.get(r+1)||`<row r="${r+1}"/>`;
      const height=r===sheet.headerRow?42:Math.min(120,Math.max(28,...values.slice(sheet.originalColumns).map((v,c)=>String(v??'').split('\n').reduce((n,line)=>n+Math.max(1,Math.ceil(line.length/(resultWidth(c)-2))),0)*13+10)));
      if(Number(attr(row,'ht')||0)<height){row=setAttr(row,'ht',height);row=setAttr(row,'customHeight',1);}
      row=/\/>$/.test(row)?row.replace(/\/>$/,'>'+cells+'</row>'):row.replace(/<\/row>$/,cells+'</row>');existing.set(r+1,row);
    }
    source=source.replace(dataMatch[0],'<sheetData>'+[...existing.entries()].sort((a,b)=>a[0]-b[0]).map(([,row])=>row).join('')+'</sheetData>');
    const start=sheet.originalColumns+1,end=sheet.columns,columns=[];
    for(const tag of collection(source,'cols','col')){const min=Number(attr(tag,'min')),max=Number(attr(tag,'max'));if(max<start||min>end)columns.push(tag);else{if(min<start)columns.push(setAttr(tag,'max',start-1));if(max>end)columns.push(setAttr(tag,'min',end+1));}}
    for(let c=start;c<=end;c++)columns.push(`<col min="${c}" max="${c}" width="${resultWidth(c-start)}" customWidth="1"/>`);
    const cols='<cols>'+columns.sort((a,b)=>Number(attr(a,'min'))-Number(attr(b,'min'))).join('')+'</cols>',colsRe=/<cols\b[^>]*?(?:\/>|>[\s\S]*?<\/cols>)/;
    source=colsRe.test(source)?source.replace(colsRe,cols):source.replace(/<sheetData\b/,cols+'<sheetData');
    const oldDimension=source.match(/<dimension\b[^>]*\/>/),oldRef=attr(oldDimension?.[0]||'','ref')?.split(':').pop()||'',oldColumn=oldRef.match(/[A-Z]+/)?.[0]||'A';let oldIndex=0;for(const char of oldColumn)oldIndex=oldIndex*26+char.charCodeAt(0)-64;
    const dimension=`<dimension ref="A1:${col(Math.max(end,oldIndex)-1)}${Math.max(sheet.rows.length,Number(oldRef.match(/\d+/)?.[0])||1)}"/>`;
    if(oldDimension)source=source.replace(oldDimension[0],dimension);
    else{const properties=source.match(/<sheetPr\b[^>]*?(?:\/>|>[\s\S]*?<\/sheetPr>)/);source=properties?source.replace(properties[0],properties[0]+dimension):source.replace(/(<worksheet\b[^>]*>)/,'$1'+dimension);}
    if(!/<tableParts\b/.test(source)){
      const filter=source.match(/<autoFilter\b[^>]*?(?:\/>|>[\s\S]*?<\/autoFilter>)/),ref=`A${sheet.headerRow+1}:${col(end-1)}${Math.max(sheet.headerRow+2,sheet.rows.length)}`;
      if(filter)source=source.replace(filter[0],setAttr(filter[0],'ref',ref));
      else{const offset=source.indexOf('</sheetData>')+'</sheetData>'.length;source=source.slice(0,offset)+source.slice(offset).replace(/<(sortState|dataConsolidate|customSheetViews|mergeCells|phoneticPr|conditionalFormatting|dataValidations|hyperlinks|printOptions|pageMargins|pageSetup|headerFooter|rowBreaks|colBreaks|customProperties|cellWatches|ignoredErrors|smartTags|drawing|legacyDrawing|legacyDrawingHF|picture|oleObjects|controls|webPublishItems|tableParts|extLst)\b|<\/worksheet>/,`<autoFilter ref="${ref}"/>$&`);}
    }
    return source;
  }
  async function preserveXlsx(template,sheets,Zip,onProgress,original){
    const zip=await Zip.loadAsync(original,{checkCRC32:true}),seed=await Zip.loadAsync(template,{checkCRC32:true});
    if(!zip.file('xl/workbook.xml')||!zip.file('xl/styles.xml'))throw new Error('Izvorni XLSX nema očekivanu strukturu. Sačuvaj ga ponovo u Excelu kao .xlsx.');
    const templateSheet=normalizeXml(await seed.file('xl/worksheets/sheet1.xml').async('string'));
    const seedStyle=ref=>templateSheet.match(new RegExp('<c\\b(?=[^>]*\\br="'+ref+'")[^>]*'))?.[0].match(/\bs="(\d+)"/)?.[1]||'0';
    const combined=copyResultStyles(await zip.file('xl/styles.xml').async('string'),await seed.file('xl/styles.xml').async('string'),{resultHeader:seedStyle('B1'),text:seedStyle('A2'),price:seedStyle('B2'),date:seedStyle('C2')});
    zip.file('xl/styles.xml',combined.xml);
    const workbook=normalizeXml(await zip.file('xl/workbook.xml').async('string')),relationships=await zip.file('xl/_rels/workbook.xml.rels').async('string'),paths=new Map();
    for(const tag of relationships.match(/<Relationship\b[^>]*\/>/g)||[])paths.set(attr(tag,'Id'),resolveSheetPath(decode(attr(tag,'Target'))));
    const sourceSheets=new Map((workbook.match(/<sheet\b[^>]*\/>/g)||[]).map(tag=>[decode(attr(tag,'name')),paths.get(attr(tag,'r:id'))]));
    for(let i=0;i<sheets.length;i++){const sheet=sheets[i];if(!sheet.processed)continue;if(sheet.rows.length>1048576||sheet.columns>16384)throw new Error('Tabela prelazi ograničenje Excel formata (1.048.576 redova ili 16.384 kolone).');const entry=sourceSheets.get(sheet.name);if(!entry||!zip.file(entry))throw new Error('Nije pronađen izvorni Excel list: '+sheet.name);zip.file(entry,patchSheet(await zip.file(entry).async('string'),sheet,combined.styles));onProgress(i,sheet.rows.length,sheet.rows.length);await new Promise(resolve=>setTimeout(resolve,0));}
    return zip.generateAsync({type:'arraybuffer',compression:'DEFLATE'});
  }
  async function build(template,sheets,Zip,onProgress=()=>{},originalWorkbook=null){
    if(originalWorkbook)return preserveXlsx(template,sheets,Zip,onProgress,originalWorkbook);
    const zip=await Zip.loadAsync(template,{checkCRC32:true});
    const seed=normalizeXml(await zip.file('xl/worksheets/sheet1.xml').async('string'));
    const style=ref=>seed.match(new RegExp('<c\\b(?=[^>]*\\br="'+ref+'")[^>]*'))?.[0].match(/\bs="(\d+)"/)?.[1]||'0';
    const styles={header:style('A1'),resultHeader:style('B1'),text:style('A2'),price:style('B2'),date:style('C2')};
    let sheetTags='',relationships='',overrides='';
    for(let index=0;index<sheets.length;index++){
      const sheet=sheets[index],rows=sheet.rows,columns=Math.max(1,sheet.columns);
      if(rows.length>1048576||columns>16384)throw new Error('Tabela prelazi ograničenje Excel formata (1.048.576 redova ili 16.384 kolone).');
      let data='';
      for(let r=0;r<rows.length;r++){
        const values=rows[r]||[];let cells='';
        for(let c=0;c<values.length;c++){const value=values[c];if(value===undefined||value===null||value==='')continue;const header=sheet.processed&&r===sheet.headerRow;
          const chosen=header?(c>=sheet.originalColumns?styles.resultHeader:styles.header):value instanceof Date?styles.date:c===sheet.originalColumns+1&&sheet.processed?styles.price:styles.text;
          cells+=cell(col(c)+(r+1),value,chosen);
        }
        const height=sheet.processed&&r===sheet.headerRow?42:Math.min(90,Math.max(28,...values.map(v=>Math.ceil(String(v??'').length/38)*13+10)));
        data+=`<row r="${r+1}" ht="${height}" customHeight="1">${cells}</row>`;
        if(r%500===0){onProgress(index,r,rows.length);await new Promise(resolve=>setTimeout(resolve,0));}
      }
      const freeze=sheet.processed?sheet.headerRow+1:0;
      const view=freeze?`<pane ySplit="${freeze}" topLeftCell="A${freeze+1}" activePane="bottomLeft" state="frozen"/>`:'';
      let widths='';for(let c=0;c<columns;c++){const result=sheet.processed&&c>=sheet.originalColumns;const offset=c-sheet.originalColumns;const width=result?([30,18,14,48,22,26,22,22,58][offset]||25):Math.min(40,Math.max(16,String(rows[sheet.headerRow]?.[c]??'').length+3));widths+=`<col min="${c+1}" max="${c+1}" width="${width}" customWidth="1"/>`;}
      const filter=sheet.processed?`<autoFilter ref="A${sheet.headerRow+1}:${col(columns-1)}${Math.max(sheet.headerRow+2,rows.length)}"/>`:'';
      const content=`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:${col(columns-1)}${Math.max(1,rows.length)}"/><sheetViews><sheetView workbookViewId="0" showGridLines="0">${view}</sheetView></sheetViews><sheetFormatPr defaultRowHeight="28"/><cols>${widths}</cols><sheetData>${data}</sheetData>${filter}<pageMargins left="0.3" right="0.3" top="0.5" bottom="0.5" header="0.2" footer="0.2"/><pageSetup orientation="landscape" paperSize="9" fitToWidth="1" fitToHeight="0"/></worksheet>`;
      zip.file(`xl/worksheets/sheet${index+1}.xml`,content);
      sheetTags+=`<sheet name="${xml(sheet.name)}" sheetId="${index+1}" r:id="recommendSheet${index+1}"/>`;
      relationships+=`<Relationship Id="recommendSheet${index+1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index+1}.xml"/>`;
      overrides+=`<Override PartName="/xl/worksheets/sheet${index+1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`;
    }
    let workbook=normalizeXml(await zip.file('xl/workbook.xml').async('string'));
    workbook=workbook.replace(/<sheets>[\s\S]*?<\/sheets>/,'<sheets>'+sheetTags+'</sheets>').replace(/<definedNames>[\s\S]*?<\/definedNames>/,'');
    if(!/<workbook\b[^>]*xmlns:r=/.test(workbook))workbook=workbook.replace(/<workbook\b/,'<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"');
    zip.file('xl/workbook.xml',workbook);
    let rels=await zip.file('xl/_rels/workbook.xml.rels').async('string');
    rels=rels.replace(/<Relationship\b(?=[^>]*Type="[^"]*\/worksheet")[^>]*\/>/g,'').replace('</Relationships>',relationships+'</Relationships>');zip.file('xl/_rels/workbook.xml.rels',rels);
    let types=await zip.file('[Content_Types].xml').async('string');types=types.replace(/<Override\b(?=[^>]*PartName="\/xl\/worksheets\/)[^>]*\/>/g,'').replace('</Types>',overrides+'</Types>');zip.file('[Content_Types].xml',types);
    if(zip.file('docProps/app.xml')){let app=await zip.file('docProps/app.xml').async('string');app=app.replace(/<TitlesOfParts>[\s\S]*?<\/TitlesOfParts>/,`<TitlesOfParts><vt:vector size="${sheets.length}" baseType="lpstr">${sheets.map(s=>'<vt:lpstr>'+xml(s.name)+'</vt:lpstr>').join('')}</vt:vector></TitlesOfParts>`).replace(/(<vt:lpstr>Worksheets<\/vt:lpstr>[\s\S]*?<vt:i4>)\d+/,`$1${sheets.length}`);zip.file('docProps/app.xml',app);}
    return zip.generateAsync({type:'arraybuffer',compression:'DEFLATE'});
  }
  return {build};
});
