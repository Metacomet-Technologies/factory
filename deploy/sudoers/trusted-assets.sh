# shellcheck shell=bash
# MET-375: sourced, never run, by the allowlisted installers and rollbacks when they run from the
# root-owned tree Devon staged with stage-trusted.sh (deploy/sudoers/README.md). Before any change,
# trusted_assets refuses unless the tree, every parent directory and each named file (relative to the
# tree) are root-owned, not group- or other-writable and not symlinks, and each file still has the
# digest recorded in SHA256SUMS when the verified release was staged. There is no fallback.
trusted_tree=/usr/local/lib/factory-deploy
trusted_path() {
    local path=$1 owner mode
    while :; do
        [[ ! -L "$path" ]] || fail "Refusing symlinked trusted asset: $path"
        [[ -e "$path" ]] || fail "Missing trusted asset: $path; Devon restages the verified release (deploy/sudoers/README.md)."
        read -r owner mode < <(stat -c '%u %a' -- "$path")
        [[ $owner == 0 && $(( 8#$mode & 8#022 )) == 0 ]] || fail "Trusted asset is writable by a non-root user: $path"
        [[ "$path" != / ]] || return 0
        path=$(dirname "$path")
    done
}
trusted_assets() {
    local file digest name found
    trusted_path "$trusted_tree/SHA256SUMS"
    for file; do
        trusted_path "$trusted_tree/$file"
        [[ -f "$trusted_tree/$file" ]] || fail "Trusted asset is not a regular file: $trusted_tree/$file"
        found=
        while read -r digest name; do
            if [[ "$name" == "$file" ]]; then [[ -z $found ]] || fail "Duplicate staged digest: $file"; found=$digest; fi
        done < "$trusted_tree/SHA256SUMS"
        [[ -n $found ]] || fail "No staged digest for $file; Devon restages the verified release."
        digest=$(sha256sum -- "$trusted_tree/$file")
        [[ ${digest%% *} == "$found" ]] || fail "Trusted asset changed since staging: $trusted_tree/$file"
    done
}
