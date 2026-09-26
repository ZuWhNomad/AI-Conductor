# Conductor MCP client (stdlib only). Usage: python mcp.py <base-url> <session-id> <tool> ['<json args>' | '@args.json']
#          python mcp.py <base-url> <session-id> tools/list   (every tool's input schema)
import json, sys, urllib.request
base, sid, tool, a = (sys.argv[1:5] + ['{}'])[:4]
args = json.load(open(a[1:], encoding='utf-8')) if a.startswith('@') else json.loads(a)
body = {'jsonrpc': '2.0', 'id': 1, 'method': 'tools/list'} if tool == 'tools/list' else \
       {'jsonrpc': '2.0', 'id': 1, 'method': 'tools/call', 'params': {'name': tool, 'arguments': args}}
req = urllib.request.Request(f'{base}/mcp/{sid}', json.dumps(body).encode(), {'content-type': 'application/json'})
res = json.load(urllib.request.urlopen(req, timeout=3700))
sys.stdout.reconfigure(encoding='utf-8')
if tool == 'tools/list': sys.exit(print(json.dumps({t['name']: t['inputSchema'] for t in res['result']['tools']})))
r = res.get('result') or {'isError': True, 'content': [{'text': json.dumps(res.get('error'))}]}
print(r['content'][0]['text']); sys.exit(1 if r['isError'] else 0)
