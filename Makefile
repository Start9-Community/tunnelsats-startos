ARCHES := x86_64 aarch64

.PHONY: version.json

# Always synchronize version.json from startos/versions/current.ts on every build
version.json:
	node scripts/sync-version.js

# overrides to s9pk.mk must precede the include statement
# A plain `make` builds the packages; without this the first target in this
# file (version.json) would be the default goal and nothing would be built.
.DEFAULT_GOAL := all
include node_modules/@start9labs/start-sdk/s9pk.mk

ingredients: version.json
