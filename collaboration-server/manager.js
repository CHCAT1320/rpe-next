const field = id => document.getElementById(id);
function render(state) {
  field('start').disabled = state.running; field('stop').disabled = !state.running; field('port').disabled = state.running; field('lan').disabled = state.running; field('key').disabled = state.running;
  field('tunnel').disabled = !state.running || state.tunnel || !state.tunnelPath;
  field('status').textContent = state.message; field('counts').textContent = `${state.rooms} 个房间 · ${state.users} 位在线用户`;
  field('local').textContent = state.running ? `本机：ws://127.0.0.1:${state.port}/collab　${state.localAddresses.join('　')}` : '';
  field('public').value = state.publicAddress; field('tunnel-path').textContent = state.tunnelPath.split(/[\\/]/).at(-1);
}
for (const action of ['start', 'stop', 'choose-tunnel', 'tunnel']) field(action).onclick = async () => render(await window.serverManager.action(action, { port: field('port').value, lan: field('lan').checked, key: field('key').value, token: field('token').value }));
const download = document.createElement('button'); download.textContent = '打开官方下载页'; download.onclick = () => window.serverManager.action('download-tunnel'); field('choose-tunnel').before(download);
field('copy').onclick = async () => { if (field('public').value) { await navigator.clipboard.writeText(field('public').value); field('status').textContent = '公网地址已复制'; } };
window.serverManager.subscribe(render); window.serverManager.action('state').then(state => { field('port').value = state.preferences.port; field('lan').checked = state.preferences.lan; render(state); });
