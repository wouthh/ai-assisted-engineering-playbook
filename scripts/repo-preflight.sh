#!/usr/bin/env bash

set -eu
unset GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_CONFIG GIT_CONFIG_PARAMETERS \
  GIT_CONFIG_COUNT GIT_OBJECT_DIRECTORY GIT_DIR GIT_WORK_TREE \
  GIT_IMPLICIT_WORK_TREE GIT_GRAFT_FILE GIT_INDEX_FILE \
  GIT_NO_REPLACE_OBJECTS GIT_REPLACE_REF_BASE GIT_PREFIX GIT_SHALLOW_FILE \
  GIT_COMMON_DIR 2>/dev/null || :
export GIT_OPTIONAL_LOCKS=0
export GIT_NO_LAZY_FETCH=1
export GIT_GRAFT_FILE=/dev/null

git_read() {
  git --no-optional-locks --no-replace-objects \
    -c core.fsmonitor=false \
    -c core.trustctime=true \
    -c core.checkStat=default \
    -c core.ignoreStat=false \
    -c core.fileMode=true \
    "$@"
}

repository=${1:-.}

if ! root=$(git_read -C "$repository" rev-parse --show-toplevel 2>/dev/null); then
  printf 'preflight: not a Git working tree\n' >&2
  exit 2
fi

if ! branch=$(git_read -C "$root" symbolic-ref --quiet --short HEAD); then
  printf 'preflight: detached HEAD\n' >&2
  exit 3
fi

if ! head_sha=$(git_read -C "$root" rev-parse HEAD 2>/dev/null); then
  printf 'preflight: unable to resolve HEAD\n' >&2
  exit 6
fi

if ! upstream=$(git_read -C "$root" rev-parse --abbrev-ref --symbolic-full-name '@{upstream}' 2>/dev/null); then
  printf 'preflight: branch has no upstream\n' >&2
  exit 4
fi

for operation_marker in MERGE_HEAD CHERRY_PICK_HEAD REVERT_HEAD rebase-merge rebase-apply sequencer BISECT_START; do
  if ! marker_path=$(git_read -C "$root" rev-parse --path-format=absolute --git-path "$operation_marker" 2>/dev/null); then
    printf 'preflight: unable to inspect Git operation state\n' >&2
    exit 6
  fi
  if [ -e "$marker_path" ]; then
    printf 'preflight: Git operation is in progress\n' >&2
    exit 7
  fi
done

if ! submodule_operation_state=$(git_read -C "$root" submodule foreach --quiet --recursive '
  for operation_marker in MERGE_HEAD CHERRY_PICK_HEAD REVERT_HEAD rebase-merge rebase-apply sequencer BISECT_START; do
    if ! marker_path=$(git --no-optional-locks --no-replace-objects rev-parse --path-format=absolute --git-path "$operation_marker" 2>/dev/null); then
      exit 1
    fi
    if [ -e "$marker_path" ]; then
      printf "operation\n"
    fi
  done
' 2>/dev/null); then
  printf 'preflight: unable to inspect submodule Git operation state\n' >&2
  exit 6
fi

if [ -n "$submodule_operation_state" ]; then
  printf 'preflight: Git operation is in progress in a submodule\n' >&2
  exit 7
fi

if ! index_state=$(git_read -C "$root" ls-files --recurse-submodules -v 2>/dev/null); then
  printf 'preflight: unable to inspect tracked-path index flags\n' >&2
  exit 6
fi

if printf '%s\n' "$index_state" | LC_ALL=C grep -Eq '^[a-zS] '; then
  printf 'preflight: tracked paths use assume-unchanged or skip-worktree\n' >&2
  exit 8
fi

printf 'root\t%s\n' "$root"
printf 'branch\t%s\n' "$branch"
printf 'head\t%s\n' "$head_sha"
printf 'upstream\t%s\n' "$upstream"

if ! working_state=$(git_read -C "$root" status --porcelain=v1 --untracked-files=all --ignore-submodules=none 2>/dev/null); then
  printf 'preflight: unable to determine working-tree state\n' >&2
  exit 6
fi

if [ -n "$working_state" ]; then
  printf 'preflight: working tree is not clean\n' >&2
  exit 5
fi

printf 'working_tree\tclean\n'
