use memchr::memchr;
use smallvec::SmallVec;

pub(crate) type FxHashMap<K, V> = rustc_hash::FxHashMap<K, V>;
pub(crate) type FxHashSet<T> = rustc_hash::FxHashSet<T>;
pub(crate) type SmallIndexVec = SmallVec<[usize; 1]>;

pub(crate) struct ByteLines<'a> {
    bytes: &'a [u8],
}

impl<'a> ByteLines<'a> {
    pub(crate) fn new(bytes: &'a [u8]) -> Self {
        Self { bytes }
    }
}

impl<'a> Iterator for ByteLines<'a> {
    type Item = &'a [u8];

    fn next(&mut self) -> Option<Self::Item> {
        if self.bytes.is_empty() {
            return None;
        }
        if let Some(newline) = memchr(b'\n', self.bytes) {
            let (line, rest) = self.bytes.split_at(newline);
            self.bytes = &rest[1..];
            Some(line)
        } else {
            let line = self.bytes;
            self.bytes = &[];
            Some(line)
        }
    }
}

pub(crate) fn byte_lines(bytes: &[u8]) -> ByteLines<'_> {
    ByteLines::new(bytes)
}

pub(crate) fn suffix_string(value: &str, suffix: &str) -> String {
    let mut output = String::with_capacity(value.len() + suffix.len());
    output.push_str(value);
    output.push_str(suffix);
    output
}

#[cfg(test)]
mod tests {
    use super::{byte_lines, suffix_string};

    #[test]
    fn byte_lines_returns_newline_delimited_slices() {
        let lines = byte_lines(b"one\ntwo\nthree").collect::<Vec<_>>();

        assert_eq!(
            lines,
            [b"one".as_slice(), b"two".as_slice(), b"three".as_slice()]
        );
    }

    #[test]
    fn suffix_string_builds_without_formatting() {
        assert_eq!(
            suffix_string("claude-sonnet-4", "-fast"),
            "claude-sonnet-4-fast"
        );
    }
}
