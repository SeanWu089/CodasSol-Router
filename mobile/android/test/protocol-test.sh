#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
OUT=$(mktemp -d)
trap 'rm -rf "$OUT"' EXIT
"${JAVA_HOME:?Set JAVA_HOME to JDK 17}/bin/javac" -d "$OUT" app/src/main/java/com/codassol/mobile/Protocol.java test/ProtocolTest.java
"$JAVA_HOME/bin/java" -cp "$OUT" com.codassol.mobile.ProtocolTest
