(function(){var SUP=["en", "ru", "es", "pt", "fr", "de", "tr", "ar", "hi", "id", "ja", "ko", "zh"],K='gv_lang',s=null;
try{s=localStorage.getItem(K)}catch(e){}
document.addEventListener('click',function(e){var a=e.target.closest&&e.target.closest('a[data-lang]');if(a){try{localStorage.setItem(K,a.getAttribute('data-lang'))}catch(_){}}});
if(!document.documentElement.hasAttribute('data-auto'))return;
function norm(t){t=(t||'').toLowerCase();var b=t.split('-')[0];return SUP.indexOf(b)>-1?b:null}
var pick=s&&SUP.indexOf(s)>-1?s:null;
if(!pick){var l=navigator.languages&&navigator.languages.length?navigator.languages:[navigator.language];
for(var i=0;i<l.length&&!pick;i++)pick=norm(l[i]);
if(pick){try{localStorage.setItem(K,pick)}catch(e){}}}
if(pick&&pick!=='en')location.replace('/'+pick+'/');})();
