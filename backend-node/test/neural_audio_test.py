"""Pure segmentation checks; no model download or inference."""
import importlib.util
from pathlib import Path
import re
import unittest

spec=importlib.util.spec_from_file_location('worker',Path(__file__).parents[1]/'scripts/neural-audio.py')
worker=importlib.util.module_from_spec(spec);spec.loader.exec_module(worker)

class Segmentation(unittest.TestCase):
    def test_preserves_words_and_punctuation(self):
        for text in ['先判断方向。再找到位置！注意单位？'*20,'First sentence! Another example? Third sentence. '*40,'甲'*1200,'第一段\n第二段\n\n第三段']:
            chunks=worker.split_text(text,60)
            self.assertTrue(chunks)
            self.assertEqual(re.sub(r'\s+','',text),re.sub(r'\s+','',''.join(chunks)))
            self.assertTrue(all(len(c)<=61 for c in chunks))
        self.assertEqual(worker.split_text('Hello! Next sentence?',60),['Hello! Next sentence?'])
    def test_empty(self):
        self.assertEqual(worker.split_text(' \n\t'),[])

if __name__=='__main__':unittest.main()
