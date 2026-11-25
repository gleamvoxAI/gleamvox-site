(function(){var SUP=["en", "ru", "es", "pt", "fr", "de", "tr", "ar", "hi", "id", "ja", "ko", "zh"],K='gv_lang',s=null;
try{(function(){var D=document.documentElement,tm=null;
function left(){var e=null;try{e=sessionStorage.getItem('gv_web_exp')}catch(x){}
if(!e||!/^[0-9]{1,12}$/.test(e))return 0;var ms=Number(e)*1000-Date.now()-30000;return ms>0&&ms<=3630000?ms:0}
function mark(){var ms=left();if(tm){clearTimeout(tm);tm=null}
if(ms){D.setAttribute('data-gv-in','');tm=setTimeout(mark,ms)}else D.removeAttribute('data-gv-in')}
mark();addEventListener('pageshow',mark)})()}catch(e){}
try{s=localStorage.getItem(K)}catch(e){}
document.addEventListener('click',function(e){var a=e.target.closest&&e.target.closest('a[data-lang]');if(a){try{localStorage.setItem(K,a.getAttribute('data-lang'))}catch(_){}}});
if(!document.documentElement.hasAttribute('data-auto'))return;
function norm(t){t=(t||'').toLowerCase();var b=t.split('-')[0];return SUP.indexOf(b)>-1?b:null}
var pick=s&&SUP.indexOf(s)>-1?s:null;
if(!pick){var l=navigator.languages&&navigator.languages.length?navigator.languages:[navigator.language];
for(var i=0;i<l.length&&!pick;i++)pick=norm(l[i]);
if(pick){try{localStorage.setItem(K,pick)}catch(e){}}}
if(pick&&pick!=='en')location.replace('/'+pick+'/');})();
