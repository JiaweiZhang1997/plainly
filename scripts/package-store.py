"""Package only audited extension outputs; never include project/test/profile files."""
from pathlib import Path
import hashlib,json,shutil,zipfile,struct,re
root=Path(__file__).resolve().parent.parent
src=root/'store-dist'
manifest=json.loads((src/'manifest.json').read_text())
version=manifest['version']
release_root=root/'releases'
out=release_root/f'Plainly-{version}-store'
out.mkdir(parents=True,exist_ok=True)
expected={'storage','contextMenus','scripting','declarativeNetRequestWithHostAccess','sidePanel'}
assert set(manifest['permissions'])==expected
assert manifest['manifest_version']==3 and manifest['default_locale']=='zh_CN'
assert (src/'privacy.html').exists()
assert (src/'LICENSE').read_bytes()==(root/'LICENSE').read_bytes()
for notice in ('THIRD_PARTY_NOTICES.txt','pdf-assets/LICENSE','pdf-assets/cmaps/LICENSE','pdf-assets/standard_fonts/LICENSE_FOXIT','pdf-assets/wasm/LICENSE_OPENJPEG'):assert (src/notice).is_file()
report=json.loads((root/'test-results/store-browser-report.json').read_text())
assert report['version']==version and report['passed']
assert not (src/'icons/reading-logo.png').exists()
private_path=root/'public/icons/reading-logo.png'
private_logo=private_path.read_bytes() if private_path.exists() else None
import base64
private_encoded=base64.b64encode(private_logo) if private_logo else None
allowed_roots={'icons','pdf-assets','_locales'}
allowed_files={'LICENSE','THIRD_PARTY_NOTICES.txt','manifest.json','background.js','options.js','popup.js','content.js','search.js','pdf.js','pdf.worker.mjs','app.css','pdf.css','popup.css','options.html','popup.html','sidepanel.html','pdf.html','privacy.html','question-mark.svg'}
files=sorted(p for p in src.rglob('*') if p.is_file())
for p in files:
 rel=p.relative_to(src)
 assert not p.is_symlink(),rel
 assert rel.parts[0] in allowed_roots or rel.as_posix() in allowed_files,rel
 assert not any(x in rel.parts for x in ('node_modules','work','tests','test-results','.git')),rel
 assert p.suffix not in {'.map','.ts','.zip','.pem'},rel
 data=p.read_bytes()
 assert not private_logo or (private_encoded not in data and data!=private_logo), f'Private artwork found in {rel}'
 if p.suffix in {'.js','.json','.html','.css'}:
  assert not re.search(rb'(?:sk-[A-Za-z0-9_-]{24,}|apikey_[A-Za-z0-9_]{24,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)',data),f'Possible credential found in {rel}'
for locale in ('en','zh_CN'):
 messages=json.loads((src/f'_locales/{locale}/messages.json').read_text())
 assert len(messages['extensionDescription']['message'])<=132
 for key in ('extensionName','extensionDescription','explainShortcut','searchShortcut'):assert messages[key]['message']
for ref in ['background.js','content.js','options.html','popup.html','sidepanel.html','pdf.html','pdf.worker.mjs']:assert (src/ref).is_file()
images=root/'store-materials/images'
for prefix in ('zh','en'):
 for name in ('01-explain','02-learn','03-languages','04-preferences','05-models'):
  data=(images/f'{prefix}-{name}.png').read_bytes();assert data[:8]==b'\x89PNG\r\n\x1a\n' and struct.unpack('>II',data[16:24])==(1280,800)
assert struct.unpack('>II',(images/'promo-440x280.png').read_bytes()[16:24])==(440,280)
assert struct.unpack('>II',(src/'icons/128.png').read_bytes()[16:24])==(128,128)
archive=out/f'plainly-{version}-chrome-web-store.zip'
with zipfile.ZipFile(archive,'w',zipfile.ZIP_DEFLATED,compresslevel=9) as z:
 for p in files:
  rel=p.relative_to(src).as_posix();entry=zipfile.ZipInfo(rel,date_time=(2026,9,30,0,0,0));entry.compress_type=zipfile.ZIP_DEFLATED;entry.external_attr=0o644<<16;z.writestr(entry,p.read_bytes())
with zipfile.ZipFile(archive) as z:
 assert 'manifest.json' in z.namelist() and not any(n.startswith('store-dist/') for n in z.namelist())
 assert z.testzip() is None
shutil.copytree(root/'store-materials',out,dirs_exist_ok=True)
shutil.copy2(src/'privacy.html',out/'privacy.html')
shutil.copy2(src/'icons/128.png',out/'images/icon-128.png')
sha=hashlib.sha256(archive.read_bytes()).hexdigest()
(out/'SHA256.txt').write_text(f'{sha}  {archive.name}\n')
checks={'version':version,'archive':archive.name,'bytes':archive.stat().st_size,'sha256':sha,'extension_files':len(files),'manifest_at_zip_root':True,'empty_keys_verified_by_isolated_browser':True,'private_avatar_excluded':True,'credential_pattern_scan':'passed (not a substitute for source review)','source_or_test_files_in_zip':False,'permissions':manifest['permissions'],'status':'prepared locally; not uploaded or submitted','remaining':['Register publisher and enter publisher details','Host privacy.html at a stable public HTTPS URL and add it in dashboard','Add dedicated limited reviewer access for paid model/Jev features if required','Review dashboard disclosures and submit']}
(out/'package-audit.json').write_text(json.dumps(checks,ensure_ascii=False,indent=2)+'\n')
for name in ('store-browser-report.json','native-pdf-panel-report.json','search-report.json','pdf-auto-report.json','content-lifecycle-report.json'):
 p=root/'test-results'/name
 if p.exists():shutil.copy2(p,out/name)
materials=shutil.make_archive(str(release_root/f'Plainly-{version}-release-materials'),'zip',release_root,out.name)
print(json.dumps({'output':str(out),'zip':str(archive),'materials':materials,'bytes':checks['bytes'],'files':len(files),'sha256':sha},indent=2))
