#!/usr/bin/env bash
# Build a sideloadable WebView APK for the Hermes mobile page.
#
# Requirements:
#   - JDK 17+ (21 tested): set JAVA_HOME, or have `java` on PATH
#   - Android SDK with build-tools + one platform: set ANDROID_SDK_ROOT
#     (or ANDROID_HOME). Without either, a few well-known locations are tried.
#
# Signing key lives OUTSIDE the repo: default is the same keys dir as the page
# password (%LOCALAPPDATA%\hermes\keys on Windows), override with HERMES_KEYS.
# A fresh key + password are generated on first build — Android only accepts an
# in-place update when the signature matches, so keep that file.
set -euo pipefail
cd "$(dirname "$0")"

# ---- locate the SDK --------------------------------------------------------
sdks=()
[ -n "${ANDROID_SDK_ROOT:-}" ] && sdks+=("$ANDROID_SDK_ROOT")
[ -n "${ANDROID_HOME:-}" ] && sdks+=("$ANDROID_HOME")
[ -n "${LOCALAPPDATA:-}" ] && sdks+=("${LOCALAPPDATA//\\//}/Android/Sdk")
sdks+=("D:/tools/android-sdk" "$HOME/Android/Sdk")

SDK=""
for d in "${sdks[@]}"; do
  if [ -d "$d/build-tools" ]; then SDK="$d"; break; fi
done
[ -n "$SDK" ] || { echo "missing: Android SDK (set ANDROID_SDK_ROOT)"; exit 1; }

# newest build-tools / platform present; SDKs use either platform/ or platforms/
BT="$(ls -d "$SDK"/build-tools/* 2>/dev/null | sort -V | tail -1 || true)"
PLATFORM=""
for pdir in "$SDK/platform" "$SDK/platforms"; do
  [ -d "$pdir" ] || continue
  cand="$(ls -d "$pdir"/android-* 2>/dev/null | sort -V | tail -1 || true)"
  if [ -n "$cand" ] && [ -f "$cand/android.jar" ]; then PLATFORM="$cand"; break; fi
done
AJAR=""
[ -n "$PLATFORM" ] && AJAR="$PLATFORM/android.jar"

# ---- locate the JDK --------------------------------------------------------
if [ -n "${JAVA_HOME:-}" ]; then
  JAVA="$JAVA_HOME/bin/java"; JAVAC="$JAVA_HOME/bin/javac"; KEYTOOL="$JAVA_HOME/bin/keytool"
elif command -v java >/dev/null 2>&1; then
  JAVA="java"; JAVAC="javac"; KEYTOOL="keytool"
  JH="$(dirname "$(dirname "$(readlink -f "$(command -v java)")")")"
  [ -x "$JH/bin/keytool" ] && KEYTOOL="$JH/bin/keytool"
else
  echo "missing: JDK (set JAVA_HOME)"; exit 1
fi

# ---- signing material (never in the repo) ----------------------------------
if [ -n "${HERMES_KEYS:-}" ]; then
  KEYDIR="$HERMES_KEYS"
elif [ -n "${LOCALAPPDATA:-}" ]; then
  KEYDIR="${LOCALAPPDATA//\\//}/hermes/keys"
else
  KEYDIR="$HOME/.hermes/keys"
fi
KS="$KEYDIR/hermes.keystore"
KS_PASS_FILE="$KEYDIR/keystore.pass"
mkdir -p "$KEYDIR"

for f in "$BT/aapt2.exe" "$AJAR" "$JAVA" "$JAVAC" "$KEYTOOL"; do
  [ -e "$f" ] || { echo "missing: $f"; exit 1; }
done

# 16 random bytes, no newline: keytool would prompt on an empty store password.
if [ ! -f "$KS_PASS_FILE" ]; then
  python -c "import secrets,pathlib,sys;pathlib.Path(sys.argv[1]).write_text(secrets.token_hex(16),encoding='utf-8')" "$KS_PASS_FILE"
  chmod 600 "$KS_PASS_FILE" 2>/dev/null || true
fi
KS_PASS="$(cat "$KS_PASS_FILE")"

if [ ! -f "$KS" ]; then
  echo "== 0/6 generating a signing key outside the repo: $KEYDIR"
  "$KEYTOOL" -genkeypair -keystore "$KS" -alias hermes \
    -keyalg RSA -keysize 2048 -validity 10000 \
    -storepass "$KS_PASS" -keypass "$KS_PASS" \
    -dname "CN=Hermes Mobile, OU=Home, O=Home, C=CN"
fi

rm -rf build
mkdir -p build/gen build/classes build/dex

echo "== 1/6 aapt2 compile"
"$BT/aapt2.exe" compile --dir res -o build/res.zip

echo "== 2/6 aapt2 link"
"$BT/aapt2.exe" link -o build/app.unsigned.apk -I "$AJAR" \
  --manifest AndroidManifest.xml -R build/res.zip \
  --java build/gen --min-sdk-version 21 --target-sdk-version 34 --auto-add-overlay

# javac output goes to a log: piping it through `tail` used to hide the first
# (real) error, and `|| true` then carried on with an empty classes dir.
echo "== 3/6 javac"
find src build/gen -name "*.java" > build/sources.txt
if ! "$JAVAC" -encoding UTF-8 --release 8 -nowarn \
      -classpath "$AJAR" -d build/classes @"build/sources.txt" > build/javac.log 2>&1; then
  echo "javac FAILED — full log:"; cat build/javac.log; exit 1
fi
warn="$(grep -ci warning build/javac.log 2>/dev/null || true)"
if [ -n "$warn" ] && [ "$warn" != "0" ]; then echo "   ($warn warnings, see build/javac.log)"; fi

echo "== 4/6 d8"
find build/classes -name "*.class" > build/classes.txt
"$JAVA" -cp "$BT/lib/d8.jar" com.android.tools.r8.D8 \
  --lib "$AJAR" --min-api 21 --output build/dex @"build/classes.txt"

echo "== 5/6 package dex"
cp build/app.unsigned.apk build/app.dex.apk
python - <<'PY'
import zipfile, shutil
src = "build/app.dex.apk"
dst = "build/app.dex2.apk"
shutil.copyfile(src, dst)
with zipfile.ZipFile(dst, "a", zipfile.ZIP_DEFLATED) as z:
    z.write("build/dex/classes.dex", "classes.dex")
shutil.move(dst, src)
print("   classes.dex appended:", __import__("os").path.getsize("build/dex/classes.dex"), "bytes")
PY

echo "== 6/6 zipalign + sign"
"$BT/zipalign.exe" -f -p 4 build/app.dex.apk build/app.aligned.apk

# 注：这个包每次构建字节都不同 —— 不是源码有问题，是 v1 签名（META-INF/*.RSA 的
# PKCS#7 带签名时间）不可复现。dex 和 resources.arsc 都是确定的，功能等价。
# 所以 tools/verify_all.py 的「工作区干净」检查故意跳过 apk/idsig。
# 要字节可复现就加 --v1-signing-enabled false，代价是 Android 5/6 装不上。
"$JAVA" -jar "$BT/lib/apksigner.jar" sign \
  --ks "$KS" --ks-pass "pass:$KS_PASS" --key-pass "pass:$KS_PASS" \
  --out ../hermes-mobile.apk build/app.aligned.apk

"$JAVA" -jar "$BT/lib/apksigner.jar" verify --print-certs ../hermes-mobile.apk

echo
echo "BUILT: $(cd .. && pwd)/hermes-mobile.apk  ($(stat -c%s ../hermes-mobile.apk) bytes)"
