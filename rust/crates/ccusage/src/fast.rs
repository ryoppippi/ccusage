use smallvec::SmallVec;

pub(crate) type FxHashMap<K, V> = rustc_hash::FxHashMap<K, V>;
pub(crate) type FxHashSet<T> = rustc_hash::FxHashSet<T>;
pub(crate) type SmallIndexVec = SmallVec<[usize; 1]>;

pub(crate) fn suffix_string(value: &str, suffix: &str) -> String {
    let mut output = String::with_capacity(value.len() + suffix.len());
    output.push_str(value);
    output.push_str(suffix);
    output
}

#[cfg(test)]
mod tests {
    use super::suffix_string;

    #[test]
    fn suffix_string_builds_without_formatting() {
        assert_eq!(
            suffix_string("claude-sonnet-4", "-fast"),
            "claude-sonnet-4-fast"
        );
    }
}
