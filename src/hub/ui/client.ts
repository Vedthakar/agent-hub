/**
 * The dashboard's only client script: progressive enhancement over plain forms. Widgets attach by
 * `data-widget`; everything they do goes through same-origin JSON endpoints under /api.
 */
export const CLIENT_JS = String.raw`(function(){
var $=function(s,r){return (r||document).querySelector(s)};
var $$=function(s,r){return Array.prototype.slice.call((r||document).querySelectorAll(s))};
var sleep=function(ms){return new Promise(function(r){setTimeout(r,ms)})};
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
function api(path,body){
  var opts={method:body===undefined?'GET':'POST',credentials:'same-origin',headers:{accept:'application/json'}};
  if(body!==undefined){opts.headers['content-type']='application/json';opts.body=JSON.stringify(body)}
  return fetch(path,opts).then(function(r){return r.json().catch(function(){return {}}).then(function(j){
    if(!r.ok){var e=new Error(j.error||('Something went wrong ('+r.status+')'));e.status=r.status;throw e}return j})})
}
function say(el,tone,html,spin){if(!el)return;el.className='status-line'+(tone?' '+tone:'');el.innerHTML=(spin?'<span class="spinner"></span>':'')+'<span>'+html+'</span>';el.classList.remove('hide')}
function ago(iso){if(!iso)return 'never';var ms=Date.now()-new Date(iso).getTime();if(ms<60000)return 'just now';if(ms<3600000)return Math.round(ms/60000)+' min ago';if(ms<86400000)return Math.round(ms/3600000)+' h ago';return Math.round(ms/86400000)+' d ago'}
async function waitJob(id){for(var i=0;i<120;i++){var j=await api('/api/jobs/'+id);if(j.status==='done'||j.status==='failed')return j;await sleep(1500)}throw new Error('Your Mac didn\'t answer. Is it awake and online?')}
function busy(btn,on){if(!btn)return;btn.disabled=on;if(on){btn.dataset.label=btn.textContent;btn.innerHTML='<span class="spinner"></span>'+esc(btn.dataset.label)}else if(btn.dataset.label){btn.textContent=btn.dataset.label}}

$$('[data-theme-toggle]').forEach(function(b){b.addEventListener('click',function(){
  var root=document.documentElement;var cur=root.dataset.theme||'light';
  var next=cur==='dark'?'light':'dark';root.dataset.theme=next;try{localStorage.setItem('theme',next)}catch(e){}})});

document.addEventListener('click',function(e){var b=e.target.closest&&e.target.closest('[data-copy]');if(!b)return;var t=$(b.getAttribute('data-copy'));if(!t)return;
  var v=t.value!==undefined?t.value:t.textContent;var done=function(){var o=b.textContent;b.textContent='Copied ✓';setTimeout(function(){b.textContent=o},1600)};
  if(navigator.clipboard&&window.isSecureContext){navigator.clipboard.writeText(v).then(done,function(){t.select&&t.select();document.execCommand('copy');done()})}else{t.select&&t.select();document.execCommand('copy');done()}});
document.addEventListener('submit',function(e){var m=e.target.getAttribute('data-confirm');if(m&&!confirm(m))e.preventDefault()});

var mac=null;
var W={};
W['mac-status']=function(el){
  var paint=function(m){mac=m;document.dispatchEvent(new CustomEvent('mac',{detail:m}));
    var on=$('[data-mac=online]',el),fda=$('[data-mac=fda]',el),node=$('[data-mac=node]',el);
    if(on){if(!m.paired&&!m.lastSeenAt)say(on,'warn','Your Mac isn\'t connected yet.');else if(m.online)say(on,'ok','Your Mac is connected'+(m.version?' (helper '+esc(m.version)+')':'')+'.');else say(on,'err','Your Mac was last seen '+esc(ago(m.lastSeenAt))+'. Is it awake and online?')}
    if(fda){if(m.fullDiskAccess===true)say(fda,'ok','Full Disk Access is on. The hub can read your agent threads (read-only).');else if(m.online&&m.fullDiskAccess===false)say(fda,'warn','Waiting for Full Disk Access…',true);else say(fda,'','Full Disk Access: connect your Mac first.')}
    if(node&&m.nodePath)node.value=m.nodePath;
    var st={paired:m.paired||!!m.lastSeenAt,unpaired:!(m.paired||m.lastSeenAt),online:m.online,offline:!m.online,'fda-ok':m.fullDiskAccess===true,'fda-missing':m.online&&m.fullDiskAccess!==true};
    $$('[data-show-when]').forEach(function(x){x.classList.toggle('hide',!st[x.getAttribute('data-show-when')])});
    $$('[data-enable-when]').forEach(function(x){x.disabled=!st[x.getAttribute('data-enable-when')]});
  };
  var tick=function(){api('/api/mac').then(paint).catch(function(){}).finally(function(){setTimeout(tick,mac&&mac.fullDiskAccess===true&&mac.online?8000:2500)})};tick();
};
W['pair']=function(el){var btn=$('[data-pair]',el),out=$('[data-pair-out]',el),cmd=$('[data-pair-command]',el),err=$('[data-pair-status]',el);
  btn&&btn.addEventListener('click',function(){busy(btn,true);api('/api/mac/pair-code',{}).then(function(r){cmd.value=r.command;out.classList.remove('hide');err&&err.classList.add('hide')})
    .catch(function(e){say(err,'err',esc(e.message))}).finally(function(){busy(btn,false)})})};
W['install-here']=function(el){var btn=$('button',el),s=$('[data-status]',el);btn.addEventListener('click',function(){busy(btn,true);say(s,'','Installing the helper on this Mac…',true);
  api('/api/mac/install',{}).then(function(){say(s,'ok','Installed. It will show up as connected in a few seconds.')}).catch(function(e){say(s,'err',esc(e.message))}).finally(function(){busy(btn,false)})})};
W['open-fda']=function(el){var btn=$('button',el),s=$('[data-status]',el);btn.addEventListener('click',function(){busy(btn,true);
  api('/api/mac/open-fda',{}).then(function(r){return waitJob(r.jobId)}).then(function(j){if(j.status==='done')say(s,'ok','System Settings is open on your Mac. Turn on the switch next to <b>node</b> (or add it with +).');else say(s,'err',esc(j.error))})
  .catch(function(e){say(s,'err',esc(e.message))}).finally(function(){busy(btn,false)})})};
W['keep-awake']=function(el){var input=$('input[type=checkbox]',el),s=$('[data-status]',el),user=false;
  document.addEventListener('mac',function(e){if(!user&&e.detail.keepAwake!=null)input.checked=!!e.detail.keepAwake;input.disabled=!e.detail.online});
  input.addEventListener('change',function(){var on=input.checked;user=true;input.disabled=true;say(s,'','Check your Mac: macOS asks for your password to '+(on?'keep it awake':'restore normal sleep')+'.',true);
    api('/api/mac/keep-awake',{on:on}).then(function(r){return waitJob(r.jobId)}).then(function(j){
      if(j.status==='done'){input.checked=!!(j.result&&j.result.keepAwake);say(s,input.checked?'ok':'',input.checked?'Keep-awake is on. Your Mac won\'t sleep, even with the lid closed.':'Normal sleep restored.')}
      else{input.checked=!on;say(s,'err',/cancel/i.test(j.error||'')?'Cancelled on the Mac. Nothing changed.':esc(j.error))}})
    .catch(function(e){input.checked=!on;say(s,'err',esc(e.message))}).finally(function(){input.disabled=false;user=false})})};
W['threads']=function(el){var btn=$('[data-find-threads]',el),list=$('[data-thread-list]',el),s=$('[data-status]',el),target=$(el.getAttribute('data-target'));
  var assigned={};try{assigned=JSON.parse(el.getAttribute('data-assigned')||'{}')}catch(e){}
  btn.addEventListener('click',function(){busy(btn,true);say(s,'','Asking your Mac for recent conversations…',true);list.innerHTML='';
    api('/api/mac/threads',{}).then(function(r){return waitJob(r.jobId)}).then(function(j){
      if(j.status!=='done'){say(s,'err',esc(j.error));return}
      var t=(j.result&&j.result.threads)||[];if(!t.length){say(s,'warn','No recent one-on-one conversations found. Text the agent once, then try again.');return}
      s.classList.add('hide');
      list.innerHTML=t.map(function(x,i){var other=assigned[x.handle];return '<label class="choice"><input type="radio" name="pick-'+esc(el.getAttribute('data-agent'))+'" value="'+esc(x.handle)+'"'+(target&&target.value===x.handle?' checked':'')+'><span class="grow"><b class="mono">'+esc(x.handle)+'</b><div class="muted small">'+x.messages+' messages · last '+esc(ago(x.lastAt))+(x.service&&x.service!=='iMessage'?' · '+esc(x.service):'')+'</div></span>'+(other?'<span class="pill sm">'+esc(other)+'</span>':'')+'</label>'}).join('');
      $$('input',list).forEach(function(r){r.addEventListener('change',function(){if(target){target.value=r.value;target.dispatchEvent(new Event('input'))}})})
    }).catch(function(e){say(s,'err',esc(e.message))}).finally(function(){busy(btn,false)})})};
W['test-text']=function(el){var btn=$('button',el),s=$('[data-status]',el),input=$(el.getAttribute('data-input'));
  btn.addEventListener('click',async function(){busy(btn,true);try{
    var r=await api('/api/approval/test',{handle:input?input.value:''});say(s,'','Sending from your Mac…',true);
    for(var i=0;i<60;i++){await sleep(1500);var o=await api('/api/outbox/'+r.outboxId);
      if(o.status==='sent'){say(s,'ok','Sent ✓ Check your phone for a text from Agent Hub.');return}
      if(o.status==='failed'){say(s,'err','Your Mac couldn\'t send it: '+esc(o.error||'unknown error')+'. The first time, macOS asks to let node control Messages. Allow it and try again.');return}}
    say(s,'warn','Still waiting for your Mac to send it. Is the helper connected?')}catch(e){say(s,'err',esc(e.message))}finally{busy(btn,false)}})};
W['test-connection']=function(el){var btn=$('button',el),s=$('[data-status]',el),agent=el.getAttribute('data-agent'),name=el.getAttribute('data-name');
  btn.addEventListener('click',async function(){busy(btn,true);try{var r=await api('/api/agents/'+agent+'/test',{});
    say(s,'','Waiting for '+esc(name)+'… Open a new chat there and say hi. It should call <code>get_situation</code> first.',true);
    for(var i=0;i<15;i++){var x=await api('/api/agents/'+agent+'/seen?since='+r.since);if(x.seen){say(s,'ok','Connected ✓ '+esc(name)+' just checked in.');return}}
    say(s,'warn','No call yet. Check the connector is switched on in '+esc(name)+' and the instructions are pasted, then try again.')}
  catch(e){say(s,'err',esc(e.message))}finally{busy(btn,false)}})};
W['test-email']=function(el){var btn=$('button',el),s=$('[data-status]',el);btn.addEventListener('click',function(){busy(btn,true);say(s,'','Sending a test email to yourself…',true);
  api('/api/email/test',{}).then(function(r){say(s,'ok','Sent ✓ to '+esc(r.to)+'. Check your inbox.')}).catch(function(e){say(s,'err',esc(e.message))}).finally(function(){busy(btn,false)})})};
W['test-router']=function(el){var btn=$('button',el),s=$('[data-status]',el);btn.addEventListener('click',function(){busy(btn,true);say(s,'','Checking…',true);
  api('/api/router/test',{}).then(function(r){say(s,'ok','Works ✓ ('+esc(r.model)+')')}).catch(function(e){say(s,'err',esc(e.message))}).finally(function(){busy(btn,false)})})};
W['telegram-login']=function(el){var loginId=null,s=$('[data-status]',el);
  var show=function(k){$$('[data-tg-step]',el).forEach(function(f){f.classList.toggle('hide',f.getAttribute('data-tg-step')!==k)})};
  var handle=function(r){if(r.status==='code-sent'){loginId=r.loginId;show('code');say(s,'','Telegram sent you a code (check the Telegram app).')}
    else if(r.status==='password-needed'){loginId=r.loginId;show('password');say(s,'','Your account has two-step verification. Enter that password.')}
    else if(r.status==='done'){show('done');say(s,'ok','Signed in as '+esc(r.account)+' ✓');setTimeout(function(){location.reload()},1200)}};
  $$('form',el).forEach(function(f){f.addEventListener('submit',function(e){e.preventDefault();var b=$('button',f);busy(b,true);var step=f.getAttribute('data-tg-step');
    var body=step==='phone'?{phone:f.phone.value}:step==='code'?{loginId:loginId,code:f.code.value}:{loginId:loginId,password:f.password.value};
    api('/api/telegram/'+(step==='phone'?'start':step),body).then(handle).catch(function(e){say(s,'err',esc(e.message))}).finally(function(){busy(b,false)})})})};
W['test-event']=function(el){var btn=$('button',el),s=$('[data-status]',el),list=$('[data-event-list]',el);
  btn.addEventListener('click',async function(){busy(btn,true);try{var r=await api('/api/test-event',{});say(s,'','Sending a test event through the hub…',true);
    for(var i=0;i<40;i++){await sleep(700);var x=await api('/api/events?since='+encodeURIComponent(r.since));var ev=(x.events||[]).filter(function(e){return e.id===r.eventId})[0];
      if(ev){list.insertAdjacentHTML('afterbegin','<li class="arrive"><span class="grow"><b>'+esc(ev.name)+'</b> · '+esc(ev.summary)+'</span><span class="time">'+esc(ago(ev.at))+'</span></li>');list.classList.remove('hide');
        say(s,'ok','It arrived ✓ This is what every agent update looks like on your Today page.');return}}
    say(s,'warn','The event was sent but hasn\'t shown up yet. Refresh in a moment.')}catch(e){say(s,'err',esc(e.message))}finally{busy(btn,false)}})};
W['today-refresh']=function(el){setInterval(function(){if(document.visibilityState!=='visible'||el.contains(document.activeElement))return;
  fetch('/?fragment=1',{credentials:'same-origin'}).then(function(r){return r.ok?r.text():null}).then(function(t){if(t)el.innerHTML=t}).catch(function(){})},20000)};
W['reveal']=function(el){var b=$('button',el),i=$('input',el);b.addEventListener('click',function(){i.type=i.type==='password'?'text':'password';b.textContent=i.type==='password'?'Show':'Hide'})};
$$('[data-widget]').forEach(function(el){var w=W[el.getAttribute('data-widget')];if(w)try{w(el)}catch(e){console.error(e)}});
})();`;
