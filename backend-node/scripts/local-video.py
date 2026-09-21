"""Entrypoint used by the workflow's existing local-media job executor."""
import argparse
from local_video.support import read_json
from local_video.runner import run

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--request',required=True)
    args=parser.parse_args()
    run(read_json(args.request))
