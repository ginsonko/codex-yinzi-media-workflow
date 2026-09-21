"""CPU-only contracts: provenance, tampering and recovery, not generation quality."""
import json
import sys
import tempfile
import unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
from local_video.support import atomic_json,digest,fingerprint,manifest,safe_child,recommend
from local_video.runner import parameters,verify_recovery

class LocalVideoTests(unittest.TestCase):
    def test_presets_and_parameter_bounds(self):
        p=parameters({})
        self.assertEqual(p['frames'],107)
        for invalid in ({'frames':30},{'width':511},{'seed':True},{'fps':60},{'steps':4}):
            with self.assertRaises(ValueError):parameters(invalid)
        data=manifest()
        self.assertEqual(len(data['files']),10)
        self.assertTrue(all(len(f['sha256'])==64 for f in data['files']))
        self.assertTrue(all('?' not in url for f in data['files'] for url in f['urls']))

    def test_manifest_paths(self):
        with tempfile.TemporaryDirectory() as folder:
            self.assertEqual(safe_child(folder,'weights/a.bin').parent.name,'weights')
            for bad in ('../a','a/../../b','C:/secret','/secret','a\\b'):
                with self.assertRaises(ValueError):safe_child(folder,bad)

    def test_advice_not_hardware_whitelist(self):
        profile={'gpus':[{'index':0,'name':'unknown future GPU','free_gib':12}],'selected_device':0,'ram_available_gib':40,'disk_free_gib':100}
        self.assertEqual(recommend(profile)['status'],'local_trial_candidate')
        self.assertEqual(recommend(profile,'title')['status'],'procedural_edit_preferred')
        self.assertFalse(recommend(profile)['automatic_cloud_fallback'])

    def test_recovery_rejects_changed_or_missing_data_and_path_escape(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder); data=root/'decoded-pixels.npy';data.write_bytes(b'fixture-not-real-pixels')
            p=parameters({});prompt='test';key=fingerprint(dict(prompt=prompt,parameters=p,model=manifest()))
            record=dict(schema=1,source_revision=manifest()['source']['revision'],model_id=manifest()['id'],parameters=p,prompt=prompt,fingerprint=key,files={'decoded-pixels.npy':dict(path='decoded-pixels.npy',sha256=digest(data),bytes=data.stat().st_size)})
            file=root/'recovery.json';atomic_json(file,record)
            self.assertEqual(verify_recovery(file,key)['fingerprint'],key)
            with self.assertRaises(ValueError):verify_recovery(file,'another-job')
            data.write_bytes(b'tampered')
            with self.assertRaises(ValueError):verify_recovery(file)
            record['files']['decoded-pixels.npy']['path']='../outside.npy';atomic_json(file,record)
            with self.assertRaises(ValueError):verify_recovery(file)

if __name__=='__main__':unittest.main()
