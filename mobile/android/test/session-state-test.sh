#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
: "${JAVA_HOME:?Set JAVA_HOME to JDK 17; build :app:assembleDebug first}"
out=$(mktemp -d)
trap 'rm -rf "$out"' EXIT
classes=app/build/tmp/kotlin-classes/debug
"$JAVA_HOME/bin/javac" -cp "$classes" -d "$out" test/SessionStateTest.java
"$JAVA_HOME/bin/java" -cp "$classes:$out" SessionStateTest
