// scan-routes.js
const fs = require('fs'), path = require('path');
const ROOT = process.cwd(), TARGET = path.join(ROOT, 'routes');
const JS = /\.js$/i;
const URL_PAT = /(app\.use|router\.(get|post|put|patch|delete|use))\s*\(\s*(['"`])\s*(https?:\/\/[^'"`)]+)\s*\3/;
const BAD_COLON = /(app\.use|router\.(get|post|put|patch|delete|use))\s*\(\s*(['"`])[^'"`]*\/:(?:\s|:|-|$)/;

function files(d){ if(!fs.existsSync(d))return []; return fs.readdirSync(d).flatMap(n=>{
  const f=path.join(d,n), s=fs.statSync(f); return s.isDirectory()?files(f):JS.test(n)?[f]:[];
});}

(function main(){
  let total=0;
  for(const f of files(TARGET)){
    const lines=fs.readFileSync(f,'utf8').split(/\r?\n/);
    const hits=[];
    lines.forEach((line,i)=>{
      const t=line.trim();
      if(URL_PAT.test(t)||BAD_COLON.test(t)) hits.push([i+1,line]);
    });
    if(hits.length){
      console.log(`\n=== ${path.relative(ROOT,f)} ===`);
      hits.forEach(([ln,txt])=>{ console.log(`L${ln}: ${txt}`); total++; });
    }
  }
  if(total===0){
    console.log('의심 줄 없음 → 실행 가드 app.js로 스택에서 정확 위치를 잡으세요.');
  } else {
    console.log(`\n총 ${total}개 의심 라인 발견 → 전부 "/path" 형태로 고치세요.`);
  }
})();
