'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const detail=fs.readFileSync(path.join(__dirname,'../saker/sak-detail.js'),'utf8');
const page=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
test('leader source panel reads only authenticated V2 case data and never writes',()=>{
 const from=detail.indexOf('function saksgrunnlagPanel(');
 const to=detail.indexOf('/* ------------------------------------------------------------------ enkel saksjournal */',from);
 assert.ok(from>0&&to>from);
 const section=detail.slice(from,to);
 assert.match(section,/OpExSakStore\.call\('getSaksgrunnlagV2',\{sakId:m\.sak\.sakId\}\)/);
 assert.doesNotMatch(section,/\.innerHTML\s*=|createSakJournalEntry|reviseSakJournalEntry|\.set\(|\.update\(/);
 assert.match(section,/grunnlagHash/);
 assert.match(section,/projectionHash/);
 assert.match(section,/hypotese/);
 assert.match(section,/erstattet/);
 assert.match(section,/chronological/);
 assert.match(detail,/page\.appendChild\(saksgrunnlagPanel\(m\)\)/);
});
test('updated UI scripts include cached-version rollout',()=>{
 assert.match(page,/saker\/sak-detail\.js\?v=2/);
 assert.match(page,/saker\/sak\.css\?v=2/);
});
