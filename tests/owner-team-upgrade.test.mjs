import { execFileSync } from "node:child_process";
import test from "node:test";

test("owner activation preserves native config and rollback retains failed metadata without admitting members", () => {
  execFileSync(
    "python3",
    [
      "-c",
      String.raw`
import importlib.util,json,pathlib,tempfile
spec=importlib.util.spec_from_file_location('upgrade','ops/linux/upgrade-engine.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
with tempfile.TemporaryDirectory() as directory:
 s=pathlib.Path(directory);(s/'data').mkdir()
 original={'auth':{'username':'owner','ownerLogin':'eriark'},'hub':{'databasePath':str(s/'data/app.db')},'machines':[{'id':'pc','ssh':{'target':'same-pc'}}],'gpt':{'endpoint':'same-browser'},'projects':[{'id':'same-project'}]}
 raw=json.dumps(original,indent=2).encode();(s/'config.json').write_bytes(raw)
 updated,root=m.owner_activation(s,original)
 assert updated['team']['enabled'] and updated['team']['registrationEnabled'] is False
 assert {k:v for k,v in updated.items() if k!='team'}==original
 assert (s/'config.json').read_bytes()==raw
 for bad in [dict(original,team={'enabled':True}),dict(original,team={'root':str(s)}),dict(original,team={'root':str(s/'data')})]:
  try:m.owner_activation(s,bad);raise RuntimeError('Expected rejection')
  except AssertionError:pass
 root.mkdir();(root/'team.db').write_bytes(b'failed candidate, retained')
 try:m.owner_activation(s,original);raise RuntimeError('Existing registry accepted')
 except AssertionError:pass
 (s/'config.json').write_text(json.dumps(updated))
 m.restore_owner_activation(s,raw,root,'abc1234')
 assert (s/'config.json').read_bytes()==raw and not root.exists()
 saved=list((s/'data').glob('team-failed-*'));assert len(saved)==1
 assert (saved[0]/'team.db').read_bytes()==b'failed candidate, retained'
 outside=s/'outside';outside.mkdir();root.symlink_to(outside,target_is_directory=True)
 try:m.owner_activation(s,original);raise RuntimeError('Symlink accepted')
 except AssertionError:pass
`,
    ],
    { stdio: "pipe" },
  );
});
