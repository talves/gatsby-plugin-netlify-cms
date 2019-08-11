workflow "Build, Test, and Publish" {
  on = "push"
  resolves = ["SemanticRelease"]
}

action "Master" {
  uses = "actions/bin/filter@master"
  args = "branch master"
}

action "YarnInstall" {
  needs = "Master"
  uses = "talves/actions-yarn@master"
  args = "install"
}

action "Test" {
  needs = "YarnInstall"
  uses = "talves/actions-yarn@master"
  args = "test"
}

action "Build" {
  needs = "Test"
  uses = "talves/actions-yarn@master"
  args = "build"
}

action "SemanticRelease" {
  needs = "Build"
  uses = "talves/actions-yarn@master"
  args = "semantic-release"
  secrets = ["GITHUB_TOKEN", "NPM_TOKEN"]
}
