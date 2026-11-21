'use strict';
(() => {
 const api=window.desktop,byId=id=>document.getElementById(`closed-apply-${id}`);
 let state=null,busy=false;
 const activityDetails=document.createElement('details'),activityTitle=document.createElement('summary'),activityStatus=document.createElement('p'),activityList=document.createElement('ol'),activityMore=document.createElement('button');
 activityDetails.id='closed-apply-activity';activityTitle.textContent='Local pull activity';activityStatus.id='closed-apply-activity-status';activityList.id='closed-apply-activity-list';activityMore.id='closed-apply-activity-more';activityMore.type='button';activityMore.textContent='Show older pull activity';
 activityDetails.append(activityTitle,activityStatus,activityList,activityMore);byId('panel').append(activityDetails);
 activityMore.addEventListener('click',()=>run('activity-more'));
 function renderActivity(value,running){
  activityDetails.hidden=!value;activityList.replaceChildren();activityMore.hidden=!value?.hasMore;activityMore.disabled=Boolean(running);
  activityStatus.textContent=value?.status==='unavailable'?'Local pull activity could not be verified. Retained transaction records and backups remain available.':value?.status==='loading'?'Reading authenticated local pull history…':value?.total?`${value.total} verified local ${value.total===1?'outcome':'outcomes'}. These records stay on this device.`:'No verified local pulls yet.';
  for(const event of value?.items||[]){const row=document.createElement('li'),button=document.createElement('button');button.type='button';button.disabled=Boolean(running);button.textContent=`${event.type==='pull.restored'?'Original restored':'Pull completed'} · ${new Date(event.at).toLocaleString()} · ${event.revisionId.slice(0,8)}`;button.addEventListener('click',()=>run('inspect',event.transactionId));row.append(button);activityList.append(row);}
 }

 const descriptions={prepared:'Ready to apply. Resolve must stay closed. The original will be backed up before replacement.',
 'pending-editor-validation':'Rename written; validation remains. Open this project in Resolve and run the prepared check from Workspace → Scripts → Utility. While the script waits, click Read Resolve check here. After it passes, quit Resolve without saving and finish validation.',
 'pending-rollback-editor-validation':'Original restored; validation remains. Open this project in Resolve and run the restoration check. While the script waits, click Read Resolve check here. After it passes, quit Resolve without saving and finish validation.',
 completed:'Apply complete. Resolve confirmed the new name and the closed project passed the final file and metadata checks. The restore point is retained.',
 'rolled-back':'Restoration complete. Resolve confirmed the original name and the restored file passed validation. The backup is retained.',
 cancelled:'Preparation cancelled. The project was not changed.',failed:'Apply stopped. Keep Resolve closed and check recovery options. The retained records explain where it stopped.',
 'publication-unverified':'The write was interrupted. Keep Resolve closed and check recovery options before continuing.',
 'validation-failed':'Validation did not finish. Run the prepared Resolve check, quit Resolve without saving, then check recovery options.',
 'backup-started':'Creating the restore point…','backed-up':'Restore point verified. Preparing the change…','candidate-started':'Preparing the change…',
 'candidate-verified':'All other stored fields match the restore point. Preparing replacement…',publishing:'Replacing the closed project…',
 'rollback-publishing':'Restoring the original project…','validating-editor':'Checking the editor result and final project…','validating-rollback':'Checking the restored project…'};
 function render(next){
  state=next;window.closedApplyLocked=Boolean(state?.reviewLocked||busy||state?.busy);
  const r=state?.transaction,a=state?.actions||{},running=busy||state?.busy;
  renderActivity(state?.activity,running);
  if(state?.retained?.some(x=>!['completed','rolled-back','cancelled'].includes(x.state)))byId('panel').hidden=false;
  byId('status').textContent=state?.error||descriptions[r?.state]||(state?.initialized?'Complete the name-change review, then choose the matching closed Project.db.':'Checking retained Apply records…');
  byId('edit').hidden=!r;byId('edit').textContent=r?`${r.projectName}: “${r.edit.oldName}” → “${r.edit.newName}”`:'';
  const check=state?.editorCheck?.transactionId===r?.transactionId?state.editorCheck:null;
  byId('check').hidden=!check;byId('check').textContent=check?.status==='verified-open'?'Resolve check passed. Quit Resolve without saving, then finish validation.':check?`Resolve menu: ${check.menuName||'Use the retained check for this transaction'}. ${check.status==='native-error'?'The editor check did not match. Keep the backup and check recovery options.':''}`:'';
  const visible={prepare:!r||['completed','rolled-back','cancelled'].includes(r.state)||r.recovery?.classification==='original-safe-replan',apply:a.apply,cancel:a.cancel,
   validate:a.validate,'prepare-check':a.validate&&(!check||['native-error','not-prepared','pending'].includes(check.status)),'read-check':a.validate&&Boolean(check)&&!['verified-open','native-error','not-prepared'].includes(check.status),
   recover:r&&!['prepared','cancelled'].includes(r.state),rollback:a.rollback,reveal:Boolean(r?.backup)};
  for(const [name,show]of Object.entries(visible)){const button=byId(name);button.hidden=!show;button.disabled=Boolean(running||name==='prepare'&&!a.prepare);}
  byId('history').hidden=!state?.retained?.length;
  const list=byId('records');list.replaceChildren();
  for(const record of state?.retained||[]){const button=document.createElement('button');button.type='button';button.textContent=`${record.projectName} — ${record.state.replaceAll('-',' ')} · ${record.transactionId.slice(0,8)}`;button.disabled=Boolean(running);button.addEventListener('click',()=>run('inspect',record.transactionId));list.append(button);}
  document.dispatchEvent(new CustomEvent('closed-apply-state',{detail:{locked:window.closedApplyLocked}}));
 }
 async function run(action,id=state?.transaction?.transactionId){if(busy)return;busy=true;render(state);try{render(action==='prepare'?await api.prepareClosedApply():action==='activity-more'?await api.loadOlderClosedApplyActivity():await api.closedApplyAction(action,id));}catch{render({...state,error:'Apply could not connect. Reopen the app to inspect retained records before continuing.'});}finally{busy=false;render(state);}}
 byId('show').addEventListener('click',()=>{byId('panel').hidden=false;byId('title').focus();byId('panel').scrollIntoView({block:'start',behavior:'instant'});});
 for(const name of ['prepare','apply','cancel','validate','prepare-check','read-check','recover','rollback','reveal'])byId(name).addEventListener('click',()=>run(name));
 api?.onClosedApplyState?.(render);api?.getClosedApplyState?.().then(render).catch(()=>render({error:'Retained records could not be read. Reopen the app before applying.'}));
})();
