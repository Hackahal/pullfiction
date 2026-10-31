#!/usr/bin/env python3
import base64,copy,hashlib,importlib.util,json,tempfile,unittest
from pathlib import Path
spec=importlib.util.spec_from_file_location('evidence',Path(__file__).with_name('renderer-evidence.py'));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
PNG=base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6P6sAAAAASUVORK5CYII=')
def report():
 h=hashlib.sha256(PNG).hexdigest()
 return {'schema':1,'results':[{'status':'captured','caseId':'fixture/x','label':'<unsafe>','timeMs':0,'category':'synthetic','image':'data:image/png;base64,'+base64.b64encode(PNG).decode(),'hash':h,'repeatHash':h,'identical':True,'native':{'captureSource':'bevy-gpu-readback','errorCount':0}}, {'status':'unsupported','caseId':'unsupported','error':'format'}]}
class Evidence(unittest.TestCase):
 def test_camera_pose_compares_direction_not_target_distance(self):
  n={'configuredCamera':{'eye':[1,2,3],'target':[11,2,3]},'camera':{'eye':[1,2,3],'target':[2,2,3]},'pvs':{'camera':{'eye':[1,2,3],'target':[2,2,3]}}}
  self.assertTrue(m.camera_agreement(n));n['pvs']['camera']['target']=[1,3,3];self.assertFalse(m.camera_agreement(n));del n['pvs'];self.assertIsNone(m.camera_agreement(n))
 def test_extract_keeps_proof_boundary_and_safe_file_names(self):
  with tempfile.TemporaryDirectory() as d:
   output=Path(d)/'e';s,c=m.extract(report(),output)
   self.assertEqual(s['renderedCases'],1);self.assertEqual(s['frozenRepeatsIdentical'],1);self.assertEqual(s['visualApproval'],'unverified')
   self.assertEqual(len(list(output.glob('*.png'))),1);self.assertIn('&lt;unsafe&gt;',(output/'index.html').read_text())
   with self.assertRaises(FileExistsError):m.extract(report(),output)
 def test_rejects_corrupt_capture_repeat_or_source(self):
  for field,value in [('hash','wrong'),('repeatHash','wrong'),('image','data:image/png;base64,bm90IHBuZw==')]:
   r=report();r['results'][0][field]=value
   with tempfile.TemporaryDirectory() as d:
    with self.assertRaises(ValueError):m.extract(r,Path(d)/'e')
  r=report();r['results'][0]['native']['captureSource']='unverified'
  with tempfile.TemporaryDirectory() as d:
   with self.assertRaises(ValueError):m.extract(r,Path(d)/'e')
if __name__=='__main__':unittest.main()
