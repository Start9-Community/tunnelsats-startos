#!/usr/bin/env bats

setup() {
  validator="$BATS_TEST_DIRNAME/../scripts/validate-release-tag.sh"
}

@test "accepts the current stable release tag" {
  run bash "$validator" v1.0.0

  [ "$status" -eq 0 ]
}

@test "accepts prerelease and build metadata tags for the current version" {
  run bash "$validator" v1.0.0-alpha.1+build.7

  [ "$status" -eq 0 ]
}

@test "rejects a tag that does not match the package version" {
  run bash "$validator" v0.5.0

  [ "$status" -ne 0 ]
  [[ "$output" == *"does not match package version"* ]]
}

@test "rejects malformed and unsafe tags" {
  run bash "$validator" 'v0.4.0.$(id)'

  [ "$status" -ne 0 ]
  [[ "$output" == *"Unsupported release tag"* ]]
}
