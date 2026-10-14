(function(){
  var pw=document.getElementById('pw'),err=document.getElementById('err'),go=document.getElementById('go');
  function submit(){
    err.textContent='';go.disabled=true;
    fetch('/api/login',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:pw.value})})
      .then(function(r){return r.json().then(function(j){return {ok:r.ok,body:j}})})
      .then(function(r){if(r.ok){location.reload()}else{err.textContent=r.body.error||'Sign in failed';go.disabled=false;pw.select()}})
      .catch(function(){err.textContent='Could not reach the server';go.disabled=false});
  }
  go.onclick=submit;
  pw.addEventListener('keydown',function(e){if(e.key==='Enter')submit()});
})();
