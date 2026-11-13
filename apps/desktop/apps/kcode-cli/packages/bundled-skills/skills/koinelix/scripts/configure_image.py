"""Configure only the public image endpoint; never accepts API keys."""
import argparse
import sys

# Configuration must not create generated files inside the verified Skill snapshot.
sys.dont_write_bytecode = True

from image_config import read_config, write_config
from wallet_client import ClientError


def main():
    parser = argparse.ArgumentParser(description="Configure the Koinelix image endpoint (not credentials).")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--url", help="Complete non-secret image generation endpoint")
    group.add_argument("--show", action="store_true", help="Show the configured endpoint")
    args = parser.parse_args()
    try:
        if args.show:
            print(read_config())
        else:
            write_config(args.url)
            print("Endpoint saved. New requests use anonymous x402 wallet payment without a service API key. Wallet confirmation and limits still apply.")
    except ClientError as error:
        print(error.code, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
