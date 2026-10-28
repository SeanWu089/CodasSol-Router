#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
out=$(mktemp -d)
trap 'rm -rf "$out"' EXIT
"${JAVA_HOME:?Set JAVA_HOME to JDK 17}/bin/javac" -d "$out" app/src/main/java/com/codassol/mobile/StreamSession.java test/StreamSessionTest.java
"$JAVA_HOME/bin/java" -cp "$out" com.codassol.mobile.StreamSessionTest
