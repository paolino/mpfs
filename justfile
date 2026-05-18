# shellcheck shell=bash
# shellcheck disable=SC2164
# https://www.shellcheck.net/wiki/SC2121
# shellcheck disable=SC2155
# https://www.shellcheck.net/wiki/SC2155

build-on-chain:
    #!/usr/bin/env bash
    cd on_chain
    aiken build

check-on-chain:
    #!/usr/bin/env bash
    cd on_chain
    aiken check

build-off-chain:
    #!/usr/bin/env bash
    cp on_chain/plutus.json off_chain/src/plutus.json
    cd off_chain
    npm install

wait_for_service service_name port:
    #!/usr/bin/env bash
    until curl -s "http://localhost:{{port}}" > /dev/null; do
        echo "Waiting for {{service_name}} to be up on port {{port}}..."
        sleep 1
    done

# shellcheck disable=SC2035
run-tests pat:
    #!/usr/bin/env bash
    just wait_for_service "yaci-store" 8080
    just wait_for_service "yaci-admin" 10000
    just wait_for_service "ogmios" 1337
    export YACI_STORE_PORT=8080
    export YACI_ADMIN_PORT=10000
    export OGMIOS_PORT=1337
    cd off_chain
    npx ava --verbose "{{pat}}"
    npx vitest run  -t "{{pat}}"

test-all:
    #!/usr/bin/env bash
    set -euo pipefail
    just wait_for_service "yaci-store" 8080
    just wait_for_service "yaci-admin" 10000
    just wait_for_service "ogmios" 1337
    export YACI_STORE_PORT=8080
    export YACI_ADMIN_PORT=10000
    export OGMIOS_PORT=1337
    cd off_chain
    npx ava
    npx vitest --bail 1 run

inspect-tx tx_dir:
    #!/usr/bin/env bash
    tx_hex=$(jq -r '."tx-hex"' "{{tx_dir}}/log.json")
    jq --arg cbor "$tx_hex" '.cborHex = $cbor' transaction.template.json > "{{tx_dir}}/tx-encoded.json"
    cardano-cli debug transaction view --tx-file "{{tx_dir}}/tx-encoded.json" | jq > "{{tx_dir}}/tx.json"

run-server-generate:
    #!/usr/bin/env bash
    cd off_chain
    rm -rf tmp
    npx tsx service/main.ts --port 3000 --seed mnemonics.txt --generate \
        --provider yaci --yaci-store-host http://localhost:8080 \
        --yaci-admin-host http://localhost:10000

run-signingless-server:
    #!/usr/bin/env bash
    cd off_chain
    rm -rf tmp
    npx tsx src/service/signingless/main.ts --port 3000 \
        --provider yaci --yaci-store-host http://localhost:8080 \
        --yaci-admin-host http://localhost:10000

docker-down:
    #!/usr/bin/env bash
    cd off_chain
    docker compose -f docker/docker-compose.yaml down --volumes

run-yaci:
    yaci-cli up --enable-yaci-store

# Run yaci-cli in docker container.
#
# The image's `[sh /app/yaci-cli.sh]` entrypoint uses bash-only
# `[ "$x" == "y" ]` syntax, which dies under busybox sh with
# `Invalid mode. Please use 'java' or 'native'.` Overriding the
# entrypoint to bash makes the script run as the author intended.
run-yaci-docker:
    #!/usr/bin/env bash
    docker run -d --name yaci-devkit \
        --entrypoint bash \
        -p 8080:8080 -p 10000:10000 -p 1337:1337 \
        bloxbean/yaci-cli:0.10.6-beta /app/yaci-cli.sh up --enable-yaci-store

# Stop and remove yaci docker container
stop-yaci-docker:
    #!/usr/bin/env bash
    docker stop yaci-devkit 2>/dev/null || true
    docker rm yaci-devkit 2>/dev/null || true

# Run all tests using docker for yaci environment
test-docker:
    #!/usr/bin/env bash
    set -euo pipefail

    # Clean up any existing container
    docker stop yaci-devkit 2>/dev/null || true
    docker rm yaci-devkit 2>/dev/null || true

    # Start yaci-cli in docker (see run-yaci-docker for the
    # --entrypoint bash rationale).
    echo "Starting yaci-cli docker container..."
    docker run -d --name yaci-devkit \
        --entrypoint bash \
        -p 8080:8080 -p 10000:10000 -p 1337:1337 \
        bloxbean/yaci-cli:0.10.6-beta /app/yaci-cli.sh up --enable-yaci-store

    # Ensure cleanup on exit
    trap 'docker stop yaci-devkit 2>/dev/null; docker rm yaci-devkit 2>/dev/null' EXIT

    # Wait for services
    just wait_for_service "yaci-store" 8080
    just wait_for_service "yaci-admin" 10000
    just wait_for_service "ogmios" 1337

    echo "All services are up. Running tests..."

    # Set environment variables and run tests
    export YACI_STORE_PORT=8080
    export YACI_ADMIN_PORT=10000
    export OGMIOS_PORT=1337
    cd off_chain
    npx ava
    npx vitest --fileParallelism=false --maxConcurrency=1 run

format:
    #!/usr/bin/env bash
    cd off_chain
    npx prettier --write "**/*.ts"
    if ! git diff --quiet; then
        echo "Formatting changed files. Please commit the changes." >&2
        exit 1
    fi

plutimus-mpfs:
    #!/usr/bin/env bash
    cd off_chain/docker/preprod
    docker compose up -d --build

build-docker tag='latest':
    #!/usr/bin/env bash
    cd off_chain
    # shellcheck disable=SC1083
    docker build -t ghcr.io/cardano-foundation/mpfs/mpfs:{{ tag }} -f docker/Dockerfile.signingless .
    # shellcheck disable=SC1083
    docker tag ghcr.io/cardano-foundation/mpfs/mpfs:{{ tag }} ghcr.io/cardano-foundation/mpfs/mpfs:latest

push-docker tag='latest':
    # shellcheck disable=SC1083
    docker push ghcr.io/cardano-foundation/mpfs/mpfs:{{ tag }}
    docker push ghcr.io/cardano-foundation/mpfs/mpfs:latest