import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { WifiManager, parseNetworks, securityMode, validateInput, validateCredentials, profileText, installWifi } from './wifi.js';
const old = '8476acd8-0437-4fcf-bcb4-fcc116ad76c5';
const scan = '*:Maturo:50\\:FE\\:39\\:71\\:A1\\:87:94:WPA2:5240 MHz\n :New:11\\:22\\:33\\:44\\:55\\:66:80:WPA2 WPA3:2412 MHz\n';
const campusScan = ' :Campus:11\\:22\\:33\\:44\\:55\\:99:75:WPA2 802.1X:2412 MHz\n';
const savedCampus = '9476acd8-0437-4fcf-bcb4-fcc116ad76c5';
test('scan parses escaped names and deduplicates bands, preserving active AP', () => {
  const rows = parseNetworks(scan + ' :Maturo:11\\:22\\:33\\:44\\:55\\:77:99:WPA2:2412 MHz\n :中文\\:room\\\\wifi:11\\:22\\:33\\:44\\:55\\:88:40::2412 MHz');
  assert.equal(rows.length, 3); assert.equal(rows[0].signal, 94); assert.equal(rows[0].band, '5 GHz'); assert.equal(rows[2].ssid, '中文:room\\wifi'); assert.equal(rows[2].mode, 'open');
  assert.equal(securityMode('WPA3'), 'sae'); assert.equal(securityMode('WPA2 802.1X'), 'wpa-eap'); assert.equal(securityMode('WEP'), 'unsupported');
  assert.equal(securityMode('WPA2 EAP'), 'wpa-eap');
  const campus = parseNetworks(campusScan)[0]; assert.equal(campus.supported, true); assert.equal(campus.mode, 'wpa-eap');
});
test('input validation and keyfile prevent field injection', () => {
  for (const body of [{ ssid: '' }, { ssid: 'x\n[connection]' }, { ssid: 'x', password: 'bad\npassword' }, { ssid: 'x', bssid: '--help' }, { ssid: 'x', identity: 'user\n[connection]' }, { ssid: 'x', anonymous_identity: 'user\0realm' }, { ssid: 'x', identity: 123 }, { ssid: 'x', password: 'a'.repeat(1025) }, { ssid: 'x', identity: '中'.repeat(85) }]) assert.throws(() => validateInput(body));
  assert.equal(validateInput({ ssid: '中文 : Wi-Fi', password: 'a b\\cdef' }).ssid, '中文 : Wi-Fi');
  const key = profileText({ uuid: old, iface: 'wlan0', ssid: '中文;foo', password: ' a\\b;cdef ', mode: 'wpa-psk' });
  assert.match(key, /ssid=\d+(;\d+)*;/); assert.match(key, /autoconnect=false/); assert.match(key, /psk=\\sa\\\\b;cdef\\s/);
});
test('PEAP credentials use enterprise password rules while personal Wi-Fi keeps PSK validation', () => {
  const input = validateInput({ ssid: 'Campus', identity: ' student@mail.sustech.edu.cn ', password: 'short' });
  assert.equal(input.identity, 'student@mail.sustech.edu.cn');
  assert.doesNotThrow(() => validateCredentials(input, { mode: 'wpa-eap' }));
  assert.throws(() => validateCredentials(validateInput({ ssid: 'New', password: 'short' }), { mode: 'wpa-psk' }), /8～63/);
  for (const body of [{ identity: 'student@mail.sustech.edu.cn' }, { password: '123456' }, { anonymous_identity: 'anonymous@realm' }]) {
    assert.throws(() => validateCredentials(validateInput({ ssid: 'Campus', ...body }), { mode: 'wpa-eap', saved_uuid: savedCampus }));
  }
  assert.doesNotThrow(() => validateCredentials(validateInput({ ssid: 'Campus' }), { mode: 'wpa-eap', saved_uuid: savedCampus }));
});
test('PEAP keyfile sets MSCHAPv2 and no CA verification, escapes identities, and contains no PSK', () => {
  const key = profileText({ uuid: old, iface: 'wlan0', ssid: 'Campus', identity: 'user\\name@realm', anonymous_identity: ' anonymous@realm ', password: ' a\\b;cd ', mode: 'wpa-eap' });
  for (const field of ['[802-1x]', 'key-mgmt=wpa-eap', 'eap=peap;', 'phase2-auth=mschapv2', 'password-flags=0', 'system-ca-certs=false', 'auth-timeout=60']) assert.ok(key.includes(field));
  assert.match(key, /^identity=user\\\\name@realm$/m);
  assert.match(key, /^anonymous-identity=\\sanonymous@realm\\s$/m);
  assert.match(key, /^password=\\sa\\\\b;cd\\s$/m);
  assert.doesNotMatch(key, /^psk=|^ca-cert=|^ca-path=/m);
  assert.doesNotMatch(profileText({ uuid: old, iface: 'wlan0', ssid: 'Campus', identity: 'user@realm', password: '123456', mode: 'wpa-eap' }), /anonymous-identity=/);
});
async function fixture(t, options = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wifi-test-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const calls = []; let active = old; const names = new Map([[old, 'Maturo']]);
  const modes = new Map([[old, 'wpa-psk']]);
  if (options.savedCampusMode) { names.set(savedCampus, 'Campus'); modes.set(savedCampus, options.savedCampusMode); }
  const manager = new WifiManager({ profileDir: dir, interfaces: () => ({ wlan0: [{ family: 'IPv4', address: active === old ? '192.168.31.250' : '192.168.5.2' }], eth0: [{ family: 'IPv4', address: '192.168.2.2' }] }), run: async args => {
    calls.push(args);
    if (args.includes('DEVICE,TYPE')) return 'wlan0:wifi\neth0:ethernet\n';
    if (args.includes('GENERAL.STATE,GENERAL.CON-UUID')) return active ? `100 (connected)\n${active}\n` : '30 (disconnected)\n--\n';
    if (args.includes('802-11-wireless.ssid')) return names.get(args.at(-1)) + '\n';
    if (args.includes('802-11-wireless-security.key-mgmt')) return modes.get(args.at(-1)) + '\n';
    if (args.includes('UUID,TYPE')) return [...names.keys()].map(uuid => `${uuid}:802-11-wireless\n`).join('');
    if (args.includes('IN-USE,SSID,BSSID,SIGNAL,SECURITY,FREQ')) return scan + campusScan;
    if (args[1] === 'load') {
      const body = await fs.readFile(args[2], 'utf8'); const uuid = body.match(/^uuid=(.*)$/m)[1];
      names.set(uuid, Buffer.from(body.match(/^ssid=(.*)$/m)[1].split(';').filter(Boolean).map(Number)).toString('utf8'));
      modes.set(uuid, body.match(/^key-mgmt=(.*)$/m)?.[1] || 'open');
      assert.equal((await fs.stat(args[2])).mode & 0o777, 0o600); return '';
    }
    if (args.includes('up')) {
      const uuid = args[args.indexOf('uuid') + 1]; active = '';
      if (options.fail && uuid !== old || options.rollbackFail && uuid === old) throw new Error('password secret subprocess output');
      active = uuid; return '';
    }
    if (args[1] === 'delete' || args[1] === 'modify') return '';
    throw new Error('Unexpected command: ' + args.join(' '));
  }});
  return { manager, calls, dir };
}
async function completed(manager, job) {
  for (let i = 0; i < 100 && manager.jobs.get(job.id).state === 'connecting'; i++) await new Promise(resolve => setTimeout(resolve, 10));
  const result = manager.jobs.get(job.id); assert.notEqual(result.state, 'connecting'); return result;
}
test('current network is idempotent and reports wireless IP separately', async t => {
  const { manager, calls } = await fixture(t); const job = await manager.connect({ ssid: 'Maturo' });
  assert.equal(job.state, 'succeeded'); assert.deepEqual(job.network.ipv4, ['192.168.31.250']); assert.deepEqual(job.network.ethernet_ipv4, ['192.168.2.2']); assert.ok(!calls.some(a => a.includes('up')));
});
test('new connection persists only after success; secret stays out of arguments and jobs', async t => {
  const { manager, calls, dir } = await fixture(t); const password = 'private-pass-123';
  const job = await manager.connect({ ssid: 'New', password }); assert.equal(job.state, 'connecting');
  await assert.rejects(manager.connect({ ssid: 'New', password }), { status: 409 }); await assert.rejects(manager.scan(), { status: 409 });
  const result = await completed(manager, job); assert.equal(result.state, 'succeeded'); assert.equal(result.network.ipv4[0], '192.168.5.2');
  assert.ok(calls.some(a => a.includes('connection.autoconnect'))); assert.equal((await fs.readdir(dir)).length, 1);
  assert.ok(!JSON.stringify(calls).includes(password)); assert.ok(!JSON.stringify(result).includes(password));
});
test('failed connection cleans new credentials and restores original network', async t => {
  const { manager, calls, dir } = await fixture(t, { fail: true });
  const result = await completed(manager, await manager.connect({ ssid: 'New', password: 'wrongpassword' }));
  assert.equal(result.state, 'failed'); assert.equal(result.restored, true); assert.equal((await fs.readdir(dir)).length, 0);
  assert.ok(calls.some(a => a.includes('up') && a.includes(old))); assert.ok(!calls.some(a => a.includes('delete') && a.includes(old)));
  assert.ok(!JSON.stringify(result).includes('secret'));
});
test('PEAP connects with a short account password; credentials stay out of argv and jobs', async t => {
  const { manager, calls, dir } = await fixture(t);
  const input = { ssid: 'Campus', identity: 'student@mail.sustech.edu.cn', anonymous_identity: 'anonymous@sustech.edu.cn', password: '123456' };
  const job = await manager.connect(input);
  const result = await completed(manager, job); assert.equal(result.state, 'succeeded');
  const file = await fs.readFile(path.join(dir, (await fs.readdir(dir))[0]), 'utf8');
  assert.match(file, /^identity=student@mail\.sustech\.edu\.cn$/m); assert.match(file, /^password=123456$/m);
  assert.ok(calls.some(a => a[0] === '--wait' && a[1] === '90' && a.includes('up')));
  for (const value of [input.identity, input.anonymous_identity, input.password]) {
    assert.ok(!JSON.stringify(calls).includes(value)); assert.ok(!JSON.stringify(job).includes(value)); assert.ok(!JSON.stringify(result).includes(value));
  }
});
test('saved PEAP profile reconnects without exposing or rewriting credentials', async t => {
  const { manager, calls, dir } = await fixture(t, { savedCampusMode: 'wpa-eap' });
  const result = await completed(manager, await manager.connect({ ssid: 'Campus' }));
  assert.equal(result.state, 'succeeded'); assert.equal(result.network.uuid, savedCampus);
  assert.deepEqual(await fs.readdir(dir), []); assert.ok(!calls.some(a => a[1] === 'load'));
});
test('same-SSID personal profile is never reused as campus credentials', async t => {
  const { manager, calls } = await fixture(t, { savedCampusMode: 'wpa-psk' });
  const campus = (await manager.scan()).networks.find(n => n.ssid === 'Campus'); assert.equal(campus.saved, false);
  await assert.rejects(manager.connect({ ssid: 'Campus' }), /校园网用户名/);
  assert.ok(!calls.some(a => a.includes('up')));
});
test('editing a saved campus account requires both credentials and creates a new profile', async t => {
  const { manager } = await fixture(t, { savedCampusMode: 'wpa-eap' });
  await assert.rejects(manager.connect({ ssid: 'Campus', identity: 'other@mail.sustech.edu.cn' }), /eduroam/);
  await assert.rejects(manager.connect({ ssid: 'Campus', password: '123456' }), /校园网用户名/);
  const result = await completed(manager, await manager.connect({ ssid: 'Campus', identity: 'other@mail.sustech.edu.cn', password: '123456' }));
  assert.equal(result.state, 'succeeded'); assert.notEqual(result.network.uuid, savedCampus);
});
test('failed PEAP authentication cleans credentials, preserves old profiles, and rolls back', async t => {
  const { manager, calls, dir } = await fixture(t, { fail: true, savedCampusMode: 'wpa-eap' });
  const result = await completed(manager, await manager.connect({ ssid: 'Campus', identity: 'student@mail.sustech.edu.cn', password: 'wrong' }));
  assert.equal(result.state, 'failed'); assert.equal(result.restored, true); assert.match(result.message, /eduroam/);
  assert.deepEqual(await fs.readdir(dir), []);
  assert.ok(!calls.some(a => a[1] === 'delete' && [old, savedCampus].includes(a.at(-1))));
  assert.ok(!JSON.stringify(result).includes('student@mail.sustech.edu.cn')); assert.ok(!JSON.stringify(result).includes('wrong'));
});
test('client cannot bypass personal password rules by claiming enterprise mode', async t => {
  const { manager } = await fixture(t);
  await assert.rejects(manager.connect({ ssid: 'New', mode: 'wpa-eap', password: 'short' }), /8～63/);
});
test('rollback failure is reported honestly', async t => {
  const { manager } = await fixture(t, { fail: true, rollbackFail: true });
  const result = await completed(manager, await manager.connect({ ssid: 'New', password: 'wrongpassword' })); assert.equal(result.restored, false);
});
test('HTTP rejects cross-origin and unmarked writes; accepts current network request', async t => {
  const { manager } = await fixture(t); const app = express(); app.use(express.json()); installWifi(app, manager);
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve))); const base = `http://127.0.0.1:${server.address().port}/api/wifi`;
  assert.equal((await fetch(base + '/scan', { method: 'POST' })).status, 403);
  assert.equal((await fetch(base + '/status', { headers: { Origin: 'http://evil.test:5173' } })).status, 403);
  const response = await fetch(base + '/connect', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Wifi-Settings': '1', Origin: 'http://127.0.0.1:5173' }, body: JSON.stringify({ ssid: 'Maturo' }) });
  assert.equal(response.status, 202); assert.equal((await response.json()).job.state, 'succeeded');
});
test('HTTP validates campus credentials and returns a credential-free asynchronous result', async t => {
  const { manager } = await fixture(t); const app = express(); app.use(express.json()); installWifi(app, manager);
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve))); const base = `http://127.0.0.1:${server.address().port}/api/wifi`;
  const headers = { 'Content-Type': 'application/json', 'X-Wifi-Settings': '1' };
  const credentials = { ssid: 'Campus', identity: 'student@mail.sustech.edu.cn', password: '123456' };
  const invalid = await fetch(base + '/connect', { method: 'POST', headers, body: JSON.stringify({ ssid: 'Campus', identity: credentials.identity }) });
  assert.equal(invalid.status, 400); assert.match((await invalid.json()).error, /eduroam/);
  const response = await fetch(base + '/connect', { method: 'POST', headers, body: JSON.stringify(credentials) });
  assert.equal(response.status, 202); const result = await response.json(); assert.equal(result.job.state, 'connecting');
  assert.equal((await completed(manager, result.job)).state, 'succeeded');
  const status = await (await fetch(base + '/jobs/' + result.job.id)).json();
  assert.equal(status.job.state, 'succeeded'); assert.equal(status.job.network.ssid, 'Campus');
  for (const value of [credentials.identity, credentials.password]) assert.ok(!JSON.stringify([result, status]).includes(value));
});
