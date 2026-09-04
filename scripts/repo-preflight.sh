#!/usr/bin/env bash

set -euo pipefail
unset GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_CONFIG GIT_CONFIG_PARAMETERS \
  GIT_CONFIG_COUNT GIT_OBJECT_DIRECTORY GIT_DIR GIT_WORK_TREE \
  GIT_IMPLICIT_WORK_TREE GIT_GRAFT_FILE GIT_INDEX_FILE \
  GIT_NO_REPLACE_OBJECTS GIT_REPLACE_REF_BASE GIT_PREFIX GIT_SHALLOW_FILE \
  GIT_COMMON_DIR GIT_CONFIG_GLOBAL GIT_CONFIG_NOSYSTEM GIT_CONFIG_SYSTEM \
  2>/dev/null || :
export GIT_OPTIONAL_LOCKS=0
export GIT_NO_LAZY_FETCH=1
export GIT_GRAFT_FILE=/dev/null
export GIT_CONFIG_NOSYSTEM=1
export GIT_CONFIG_GLOBAL=/dev/null

git_read() {
  git --no-optional-locks --no-replace-objects \
    -c core.fsmonitor=false \
    -c core.trustctime=true \
    -c core.checkStat=default \
    -c core.ignoreStat=false \
    -c core.fileMode=true \
    -c core.ignoreCase=false \
    -c core.symlinks=true \
    -c advice.graftFileDeprecated=false \
    "$@"
}

repository=${1:-.}

if core_worktree=$(git_read -C "$repository" config --get core.worktree 2>/dev/null); then
  printf 'preflight: repository config redirects the worktree\n' >&2
  exit 10
else
  config_status=$?
  if [ "$config_status" -ne 1 ]; then
    printf 'preflight: unable to inspect worktree configuration\n' >&2
    exit 6
  fi
fi

if ! root_record=$(git_read -C "$repository" rev-parse --show-toplevel 2>/dev/null && printf '.'); then
  printf 'preflight: not a Git working tree\n' >&2
  exit 2
fi
root_record=${root_record%.}
case $root_record in
  *$'\n') root=${root_record%$'\n'} ;;
  *)
    printf 'preflight: invalid repository-root record\n' >&2
    exit 6
    ;;
esac

if filter_names=$(git_read -C "$root" config --name-only --list 2>/dev/null); then
  while IFS= read -r filter_name; do
    case $filter_name in
      filter.*.clean|filter.*.process)
        printf 'preflight: repository config contains clean/process filters\n' >&2
        exit 9
        ;;
    esac
  done <<< "$filter_names"
else
  printf 'preflight: unable to inspect content-filter configuration\n' >&2
  exit 6
fi

if ! submodule_filter_state=$(git_read -C "$root" submodule foreach --quiet --recursive '
  actual=$(pwd -P && printf ".") || exit 1
  configured=$(git --no-optional-locks --no-replace-objects rev-parse --show-toplevel && printf ".") || exit 1
  if [ "$actual" != "$configured" ]; then
    exit 1
  fi
  if ! names=$(git --no-optional-locks --no-replace-objects config --name-only --list 2>/dev/null); then
    exit 1
  fi
  while IFS= read -r name; do
    case $name in
      filter.*.clean|filter.*.process) printf "filter\n" ;;
    esac
  done <<EOF
$names
EOF
' 2>/dev/null); then
  printf 'preflight: unable to inspect submodule configuration or worktree is redirected\n' >&2
  exit 6
fi

if [ -n "$submodule_filter_state" ]; then
  printf 'preflight: submodule config contains clean/process filters\n' >&2
  exit 9
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

if ! initial_index=$(git_read -C "$root" ls-files --stage -v -z --recurse-submodules | git_read -C "$root" hash-object --stdin); then
  printf 'preflight: unable to snapshot index state\n' >&2
  exit 6
fi

if ! initial_worktree=$(git_read -C "$root" status --porcelain=v1 -z --untracked-files=all --ignore-submodules=none | git_read -C "$root" hash-object --stdin); then
  printf 'preflight: unable to snapshot working-tree state\n' >&2
  exit 6
fi

if ! index_state=$(git_read -C "$root" ls-files --recurse-submodules -v 2>/dev/null); then
  printf 'preflight: unable to inspect tracked-path index flags\n' >&2
  exit 6
fi

while IFS= read -r index_entry; do
  case $index_entry in
    S\ *|[a-z]\ *)
      printf 'preflight: tracked paths use assume-unchanged or skip-worktree\n' >&2
      exit 8
      ;;
  esac
done <<< "$index_state"

printf 'root\t%q\n' "$root"
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

if ! final_branch=$(git_read -C "$root" symbolic-ref --quiet --short HEAD); then
  printf 'preflight: repository state changed during inspection\n' >&2
  exit 11
fi
if ! final_head=$(git_read -C "$root" rev-parse HEAD 2>/dev/null); then
  printf 'preflight: repository state changed during inspection\n' >&2
  exit 11
fi
if ! final_upstream=$(git_read -C "$root" rev-parse --abbrev-ref --symbolic-full-name '@{upstream}' 2>/dev/null); then
  printf 'preflight: repository state changed during inspection\n' >&2
  exit 11
fi
if ! final_index=$(git_read -C "$root" ls-files --stage -v -z --recurse-submodules | git_read -C "$root" hash-object --stdin); then
  printf 'preflight: repository state changed during inspection\n' >&2
  exit 11
fi
if ! final_worktree=$(git_read -C "$root" status --porcelain=v1 -z --untracked-files=all --ignore-submodules=none | git_read -C "$root" hash-object --stdin); then
  printf 'preflight: repository state changed during inspection\n' >&2
  exit 11
fi

if [ "$branch" != "$final_branch" ] || [ "$head_sha" != "$final_head" ] || \
  [ "$upstream" != "$final_upstream" ] || [ "$initial_index" != "$final_index" ] || \
  [ "$initial_worktree" != "$final_worktree" ]; then
  printf 'preflight: repository state changed during inspection\n' >&2
  exit 11
fi

printf 'working_tree\tclean\n'
