#!/bin/sh
set -eu

# Recebe uma cópia consistente de um console inicializado pelo stdin.
umask 077
directory=$(mktemp -d)
pid=
cleanup() {
  if [ -n "$pid" ]; then
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  fi
  rm -rf "$directory"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

export SQLITE_DB_PATH="$directory/aiops.db"
export PORT=13000
cat > "$SQLITE_DB_PATH"
test -s "$SQLITE_DB_PATH"
node --import tsx server.ts > "$directory/web.log" 2>&1 &
pid=$!

node --input-type=module -e '
const origin = "http://127.0.0.1:13000";
for (let attempt = 0; attempt < 40; attempt++) {
  try {
    const [health, auth] = await Promise.all(
      ["/api/health", "/api/auth/status"].map(path =>
        fetch(origin + path, { signal: AbortSignal.timeout(1000) }),
      ),
    );
    const healthBody = await health.json();
    const authBody = await auth.json();
    if (health.ok && auth.ok && healthBody.db === "connected" && authBody.bootstrap_required === false) {
      console.log("O Web abriu o SQLite restaurado e reconheceu o console inicializado.");
      process.exit(0);
    }
  } catch {
    // Aguarda a inicialização do Web a partir da cópia.
  }
  await new Promise(resolve => setTimeout(resolve, 250));
}
console.error("O Web não validou a cópia restaurada.");
process.exit(1);
'
