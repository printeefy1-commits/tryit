import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';

test('Nginx upload update preserves TLS/proxy settings, handles locations, and is repeatable',()=>{
 const source=`server {
  listen 80;
  server_name example.test;
  return 301 https://$host$request_uri;
}
server {
  listen 443 ssl;
  ssl_certificate /etc/cert.pem;
  client_max_body_size 52m;
  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_read_timeout 30s;
    proxy_set_header X-Pattern "{keep this}";
  }
}
`;
 const result=spawnSync('python3',['-c',`import importlib.util,sys
spec=importlib.util.spec_from_file_location('limits','scripts/configure-admin-uploads.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
source=sys.stdin.read();updated=module.updated_limits(source)
assert updated==module.updated_limits(updated)
assert updated.count('client_max_body_size 220m;')==2
assert 'client_max_body_size 52m;' not in updated
assert 'proxy_read_timeout 30s;' not in updated
for line in ['ssl_certificate /etc/cert.pem;','proxy_pass http://127.0.0.1:3000;','proxy_set_header X-Pattern "{keep this}";','return 301 https://$host$request_uri;']:assert line in updated
print('PASS')`],{cwd:new URL('..',import.meta.url),input:source,encoding:'utf8'});
 assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/PASS/);
});
