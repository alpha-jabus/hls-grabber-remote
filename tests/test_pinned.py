import hashlib
import base64
import sys
import time
import importlib.util
import json
import os
from pathlib import Path
import shutil
import socket
import ssl
import subprocess
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('pinned_client', ROOT/'native'/'pinned_client.py')
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)

class TestPinnedClient(unittest.TestCase):
    def test_config_file_and_rejection(self):
        with tempfile.TemporaryDirectory() as d:
            with patch.object(p, 'CONFIG_FILE', Path(d)/'cfg'/'client.json'):
                cfg={'url':'https://192.168.0.190:8765','token':'a'*64,'fingerprint':'AA:'*31+'AA'}
                saved=p.write_config(cfg)
                self.assertEqual(saved['fingerprint'],'aa'*32)
                self.assertEqual(p.read_config(), saved)
                self.assertEqual(p.CONFIG_FILE.stat().st_mode & 0o777, 0o600)
                with self.assertRaises(ValueError):p.write_config({**cfg,'url':'http://192.168.0.190:8765'})
                with self.assertRaises(ValueError):p.write_config({**cfg,'fingerprint':'unverified'})
                with self.assertRaises(ValueError):p.write_config({**cfg,'extra':'invalid'})

    @unittest.skipUnless(shutil.which('openssl'), 'openssl required')
    def test_pin_checked_before_any_secret_is_sent(self):
        with tempfile.TemporaryDirectory() as d:
            cert,key=Path(d)/'server.crt',Path(d)/'server.key'
            subprocess.run(['openssl','req','-x509','-newkey','rsa:2048','-nodes','-days','1',
                '-keyout',str(key),'-out',str(cert),'-subj','/CN=localhost',
                '-addext','subjectAltName=DNS:localhost'],check=True,capture_output=True)
            class Server(BaseHTTPRequestHandler):
                def handle(self):
                    try: super().handle()
                    except (BrokenPipeError, ConnectionResetError, ssl.SSLError): pass
                count=0
                last_auth=None
                last_payload=None
                def log_message(self,*a):pass
                def do_POST(self):
                    Server.count+=1
                    Server.last_auth=self.headers.get('Authorization')
                    size=int(self.headers['Content-Length']);Server.last_payload=json.loads(self.rfile.read(size))
                    out=json.dumps({'ok':True,'result':'tested'}).encode('utf-8')
                    self.send_response(200);self.send_header('Content-Length',str(len(out)));self.end_headers();self.wfile.write(out)
            api=ThreadingHTTPServer(('127.0.0.1',0),Server)
            ctx=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER);ctx.load_cert_chain(str(cert),str(key))
            api.socket=ctx.wrap_socket(api.socket,server_side=True)
            thread=threading.Thread(target=api.serve_forever,daemon=True);thread.start()
            try:
                der=ssl.PEM_cert_to_DER_cert(cert.read_text())
                fingerprint=hashlib.sha256(der).hexdigest()
                cfg={'url':f'https://127.0.0.1:{api.server_port}', 'token':'b'*64,'fingerprint':'0'*64}
                with self.assertRaisesRegex(ValueError,'PIN MISMATCH'):
                    p.pinned_request('preview',{'url':'https://video.invalid/master.m3u8',
                       'headers':[{'name':'Cookie','value':'secret'}]},config=cfg)
                self.assertEqual(Server.count,0,'Wrong pin leaked HTTP headers/body')
                cfg['fingerprint']=fingerprint
                result=p.pinned_request('preview',{'url':'https://video.invalid/master.m3u8',
                       'headers':[{'name':'Cookie','value':'secret'}]},config=cfg)
                self.assertTrue(result['ok']);self.assertEqual(Server.count,1)
                self.assertEqual(Server.last_auth,'Bearer '+'b'*64)
                self.assertEqual(Server.last_payload['headers'][0]['value'],'secret')
            finally:api.shutdown();api.server_close()

    @unittest.skipUnless(shutil.which('openssl'), 'openssl required')
    def test_actual_backend_tls_health(self):
        with tempfile.TemporaryDirectory() as tmp:
            d=Path(tmp); cert=d/'server.crt';key=d/'server.key'; akey=d/'encryption.key'
            subprocess.run(['openssl','req','-x509','-newkey','rsa:2048','-nodes','-days','1',
                '-keyout',str(key),'-out',str(cert),'-subj','/CN=localhost',
                '-addext','subjectAltName=DNS:localhost'],check=True,capture_output=True)
            akey.write_bytes(base64.b64encode(os.urandom(32))+b'\n')
            with socket.socket() as sock:
                sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
            env={**os.environ, 'HLS_API_TOKEN':'t'*64, 'HLS_BIND':'127.0.0.1', 'HLS_PORT':str(port),
                'HLS_TLS_CERT':str(cert),'HLS_TLS_KEY':str(key),'HLS_ENCRYPTION_KEY_FILE':str(akey),
                'HLS_DATA_DIR':str(d/'data')}
            proc=subprocess.Popen([sys.executable,str(ROOT/'server'/'server.py')],cwd=str(ROOT/'server'),
                                  env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
            try:
                line=proc.stdout.readline().strip()
                self.assertIn('HTTPS',line)
                pin=hashlib.sha256(ssl.PEM_cert_to_DER_cert(cert.read_text())).hexdigest()
                cfg={'url':f'https://127.0.0.1:{port}','fingerprint':pin,'token':'t'*64}
                self.assertTrue(p.pinned_request('health',config=cfg)['ok'])
                cfg['token']='w'*64
                with self.assertRaisesRegex(ValueError,'API-токен'):
                    p.pinned_request('health',config=cfg)
            finally:
                proc.terminate()
                try:proc.communicate(timeout=5)
                except subprocess.TimeoutExpired:proc.kill();proc.communicate()

if __name__=='__main__':unittest.main()
