// Isolated real Electron coverage for the production composer model controls.
const { app, BrowserWindow } = require('electron');
const { buildSync } = require('esbuild');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wga-composer-models-'));
app.setPath('userData', profile);
app.on('will-quit', () => { fs.rmSync(profile, { recursive: true, force: true }); console.log('cleanup: isolated profile removed'); });
app.whenReady().then(async () => {
  const root = path.join(__dirname, '..');
  const output = path.join(root, 'outputs/composer-models');
  fs.mkdirSync(output, { recursive: true });
  const win = new BrowserWindow({ show: false, width: 900, height: 700,
    webPreferences: { sandbox: true, backgroundThrottling: false } });
  const css = fs.readFileSync(path.join(root, 'src/renderer/styles.css'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<link\b[^>]*>/gi, '');
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html.replace('</head>', `<style>${css}</style></head>`)));
  await win.webContents.executeJavaScript(`(() => {
    const menu = document.getElementById('modelMenu'), sprite = document.getElementById('i-check').closest('svg');
    const fields = ['workerModel', 'workerReasoning', 'helperModel', 'helperReasoning'].map(id => document.getElementById(id));
    document.body.replaceChildren(sprite, ...fields, menu);
    for (const field of fields) field.hidden = true;
    menu.style.cssText = 'position:fixed;bottom:36px;left:50%;translate:-50% 0';
    window.models = [
      { id: 'gpt-6', label: 'GPT-6', efforts: ['none', 'medium', 'high', 'xhigh'] },
      { id: 'gpt-6-pro', label: 'GPT-6 Pro', efforts: ['pro'] },
      { id: '5.6', label: 'GPT-5.6 Sol', efforts: ['none', 'medium', 'high', 'xhigh', 'pro'] }
    ];
    window.api = { getChatModels: async () => ({ ok:true, data: { state:'ready', models:window.models } }),
      onChatModelsChanged: listener => { window.catalogChanged = listener; } };
  })()`);
  const script = buildSync({ entryPoints: [path.join(root, 'src/renderer/chat-models.ts')], bundle: true,
    format: 'iife', globalName: 'ChatModels', platform: 'browser', write: false }).outputFiles[0].text;
  await win.webContents.executeJavaScript(script + `
    ChatModels.initChatModels(); ChatModels.applyChatModels({multiAgent:{}, goal:{}});
    document.querySelector('#modelMenu summary').click();
    new Promise(resolve => requestAnimationFrame(resolve));`);
  win.showInactive();
  assert.deepEqual(await win.webContents.executeJavaScript('ChatModels.confirmedComposerModel()'), { model: 'gpt-6', reasoningEffort: 'high' });
  const captures = [];
  for (const width of [900, 390]) for (const theme of ['dark', 'light']) {
    win.setSize(width, 700);
    await win.webContents.executeJavaScript(`document.documentElement.dataset.theme='${theme}';
      Promise.all(document.getAnimations().map(animation => animation.finished));`);
    const bounds = await win.webContents.executeJavaScript(`(() => {
      const r=document.querySelector('#modelMenu .composer-popover').getBoundingClientRect();
      const slider=document.querySelector('#composerPowerChoices input');
      return { fits:r.left>=0 && r.right<=innerWidth && r.top>=0 && r.bottom<=innerHeight,
        rows:[...document.querySelectorAll('input[name="composerModelChoice"]')].map(input=>input.value), max:slider.max,
        overflow:document.querySelector('#modelMenu .composer-popover').scrollWidth>r.width };
    })()`);
    assert.equal(bounds.fits, true); assert.equal(bounds.overflow, false); assert.equal(bounds.max, '2');
    assert.deepEqual(bounds.rows, ['gpt-6', 'gpt-6-pro', '5.6']);
    const file = path.join(output, `${theme}-${width}.png`);
    fs.writeFileSync(file, (await win.webContents.capturePage()).toPNG()); captures.push(file);
  }
  const point = await win.webContents.executeJavaScript(`(() => {
    const input=document.querySelector('#composerPowerChoices input'); input.focus(); window.rangeBefore=input;
    window.nativeInput=Promise.withResolvers(); input.addEventListener('input',()=>window.nativeInput.resolve(),{once:true});
    AbortSignal.timeout(3000).addEventListener('abort',()=>window.nativeInput.reject(new Error('Range input did not arrive')),{once:true});
    const r=input.getBoundingClientRect(); return {x:Math.round(r.left+16),y:Math.round(r.top+r.height/2)};
  })()`);
  win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...point});
  win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...point});
  await win.webContents.executeJavaScript('window.nativeInput.promise');
  assert.deepEqual(await win.webContents.executeJavaScript('ChatModels.confirmedComposerModel()'), {model:'gpt-6',reasoningEffort:'medium'});
  for (const reasoningEffort of ['high', 'xhigh']) {
    await win.webContents.executeJavaScript(`
      window.nativeInput=Promise.withResolvers(); window.rangeBefore.addEventListener('input',()=>window.nativeInput.resolve(),{once:true});
      AbortSignal.timeout(3000).addEventListener('abort',()=>window.nativeInput.reject(new Error('Range key did not arrive')),{once:true});`);
    win.webContents.sendInputEvent({ type:'keyDown', keyCode:'RIGHT' });
    win.webContents.sendInputEvent({ type:'keyUp', keyCode:'RIGHT' });
    await win.webContents.executeJavaScript('window.nativeInput.promise');
    assert.deepEqual(await win.webContents.executeJavaScript(`({pair:ChatModels.confirmedComposerModel(), same:document.activeElement===window.rangeBefore})`),
      { pair:{ model:'gpt-6', reasoningEffort }, same:true });
  }
  await win.webContents.executeJavaScript(`window.catalogChanged({state:'pending',models:window.models});`);
  assert.equal(await win.webContents.executeJavaScript('document.activeElement===window.rangeBefore'),true);
  await win.webContents.executeJavaScript(`document.querySelector('input[name="composerModelChoice"][value="gpt-6-pro"]').click();`);
  assert.deepEqual(await win.webContents.executeJavaScript(`({pair:ChatModels.confirmedComposerModel(), disabled:document.querySelector('#composerPowerChoices input').disabled, open:document.getElementById('modelMenu').open})`),
    { pair:{ model:'gpt-6-pro', reasoningEffort:'pro' }, disabled:true, open:true });
  await win.webContents.executeJavaScript(`
    document.querySelector('input[name="composerModelChoice"]:checked').focus();
    window.nextRadio=document.querySelector('input[name="composerModelChoice"][value="gpt-6"]');
    window.nativeModelChange=Promise.withResolvers();
    document.getElementById('composerModel').addEventListener('change',()=>window.nativeModelChange.resolve(),{once:true});
    AbortSignal.timeout(3000).addEventListener('abort',()=>window.nativeModelChange.reject(new Error('Model change did not arrive')),{once:true});`);
  assert.equal(await win.webContents.executeJavaScript('document.activeElement.value'), 'gpt-6-pro');
  win.webContents.sendInputEvent({ type:'keyDown', keyCode:'LEFT' });
  win.webContents.sendInputEvent({ type:'keyUp', keyCode:'LEFT' });
  await win.webContents.executeJavaScript('window.nativeModelChange.promise');
  assert.deepEqual(await win.webContents.executeJavaScript(`({pair:ChatModels.confirmedComposerModel(), focus:document.activeElement.value, same:document.activeElement===window.nextRadio})`),
    { pair:{ model:'gpt-6', reasoningEffort:'high' }, focus:'gpt-6', same:true });
  await win.webContents.executeJavaScript(`window.catalogChanged({state:'ready',models:[{id:'future',label:'Future model',efforts:['none','xhigh']}]});`);
  assert.equal(await win.webContents.executeJavaScript('ChatModels.confirmedComposerModel()'), null);
  assert.equal(await win.webContents.executeJavaScript(`document.querySelector('#composerPowerChoices input')===null`), true);
  await win.webContents.executeJavaScript(`document.querySelector('input[name="composerModelChoice"][value="future"]').click();`);
  assert.deepEqual(await win.webContents.executeJavaScript('ChatModels.confirmedComposerModel()'), { model:'future', reasoningEffort:'xhigh' });
  console.log(JSON.stringify({ pass:true, captures, keyboard:'native radio and range preserve focus', unknown:'requires deliberate model choice' }, null, 2));
  win.destroy(); console.log('cleanup: fixture window destroyed'); app.quit();
}).catch(error => {
  console.error(error); for (const win of BrowserWindow.getAllWindows()) win.destroy();
  fs.rmSync(profile, {recursive:true,force:true}); console.log('cleanup: failed fixture and profile removed'); app.exit(1);
});
