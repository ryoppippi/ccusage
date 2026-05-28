use std::{
    fs::File,
    io::{self, BufRead, BufReader},
    path::Path,
};

use memchr::{memchr, memmem::Finder, memrchr};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct JsonlLine<'a> {
    pub bytes: &'a [u8],
}

impl<'a> JsonlLine<'a> {
    #[inline]
    pub fn as_str(self) -> Option<&'a str> {
        std::str::from_utf8(self.bytes).ok()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct MarkerLine<'a> {
    pub bytes: &'a [u8],
    pub marker_index: usize,
    pub marker_id: usize,
}

impl<'a> MarkerLine<'a> {
    #[inline]
    pub fn as_str(self) -> Option<&'a str> {
        std::str::from_utf8(self.bytes).ok()
    }
}

pub struct JsonlLines<'a> {
    bytes: &'a [u8],
}

pub struct ByteLines<'a> {
    bytes: &'a [u8],
}

#[derive(Debug)]
pub struct JsonlFileLines {
    reader: BufReader<File>,
    line: Vec<u8>,
}

impl JsonlFileLines {
    pub fn open_with_capacity(path: &Path, capacity: usize) -> io::Result<Self> {
        Ok(Self {
            reader: BufReader::with_capacity(capacity, File::open(path)?),
            line: Vec::new(),
        })
    }

    pub fn next_line(&mut self) -> io::Result<Option<&[u8]>> {
        self.line.clear();
        let bytes_read = self.reader.read_until(b'\n', &mut self.line)?;
        if bytes_read == 0 {
            return Ok(None);
        }
        Ok(Some(&self.line))
    }
}

impl<'a> JsonlLines<'a> {
    #[inline]
    pub fn new(bytes: &'a [u8]) -> Self {
        Self { bytes }
    }
}

impl<'a> ByteLines<'a> {
    #[inline]
    pub fn new(bytes: &'a [u8]) -> Self {
        Self { bytes }
    }
}

impl<'a> Iterator for ByteLines<'a> {
    type Item = &'a [u8];

    #[inline]
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

impl<'a> Iterator for JsonlLines<'a> {
    type Item = JsonlLine<'a>;

    #[inline]
    fn next(&mut self) -> Option<Self::Item> {
        if self.bytes.is_empty() {
            return None;
        }
        let (line, rest) = split_next_line(self.bytes);
        self.bytes = rest;
        Some(JsonlLine {
            bytes: trim_trailing_cr(line),
        })
    }
}

impl DoubleEndedIterator for JsonlLines<'_> {
    #[inline]
    fn next_back(&mut self) -> Option<Self::Item> {
        if self.bytes.is_empty() {
            return None;
        }
        if let Some(newline) = memrchr(b'\n', self.bytes.strip_suffix(b"\n").unwrap_or(self.bytes))
        {
            let line = &self.bytes[newline + 1..];
            self.bytes = &self.bytes[..newline];
            Some(JsonlLine {
                bytes: trim_trailing_cr(line.strip_suffix(b"\n").unwrap_or(line)),
            })
        } else {
            let line = self.bytes;
            self.bytes = &[];
            Some(JsonlLine {
                bytes: trim_trailing_cr(line.strip_suffix(b"\n").unwrap_or(line)),
            })
        }
    }
}

#[derive(Clone, Debug)]
pub struct JsonlMarkerLines<'a> {
    bytes: &'a [u8],
    finder: Finder<'a>,
    line_start: usize,
    search_start: usize,
}

impl<'a> JsonlMarkerLines<'a> {
    #[inline]
    pub fn new(bytes: &'a [u8], marker: &'a [u8]) -> Self {
        Self {
            bytes,
            finder: Finder::new(marker),
            line_start: 0,
            search_start: if marker.is_empty() { bytes.len() } else { 0 },
        }
    }
}

impl<'a> Iterator for JsonlMarkerLines<'a> {
    type Item = MarkerLine<'a>;

    #[inline]
    fn next(&mut self) -> Option<Self::Item> {
        if self.search_start >= self.bytes.len() {
            return None;
        }
        let marker_index =
            self.search_start + self.finder.find(&self.bytes[self.search_start..])?;
        while let Some(newline) = memchr(b'\n', &self.bytes[self.line_start..marker_index]) {
            self.line_start += newline + 1;
        }
        let line_end = line_end_after(self.bytes, marker_index);
        let line_start = self.line_start;
        self.line_start = line_end.saturating_add(1);
        self.search_start = self.line_start;
        Some(MarkerLine {
            bytes: trim_trailing_cr(&self.bytes[line_start..line_end]),
            marker_index: marker_index - line_start,
            marker_id: 0,
        })
    }
}

#[inline]
pub fn lines(bytes: &[u8]) -> JsonlLines<'_> {
    JsonlLines::new(bytes)
}

#[inline]
pub fn byte_lines(bytes: &[u8]) -> ByteLines<'_> {
    ByteLines::new(bytes)
}

#[inline]
pub fn lines_with_marker<'a>(bytes: &'a [u8], marker: &'a [u8]) -> JsonlMarkerLines<'a> {
    JsonlMarkerLines::new(bytes, marker)
}

pub fn lines_with_any_marker<'a>(bytes: &'a [u8], markers: &[&'a [u8]]) -> Vec<MarkerLine<'a>> {
    if markers.is_empty() {
        return Vec::new();
    }
    if markers.len() == 1 {
        return lines_with_marker(bytes, markers[0]).collect();
    }

    let mut matches = Vec::new();
    for (marker_id, marker) in markers.iter().copied().enumerate() {
        if marker.is_empty() {
            continue;
        }
        let finder = Finder::new(marker);
        let mut search_start = 0;
        while search_start < bytes.len() {
            let Some(relative_index) = finder.find(&bytes[search_start..]) else {
                break;
            };
            let marker_index = search_start + relative_index;
            let line_start = line_start_before(bytes, marker_index);
            let line_end = line_end_after(bytes, marker_index);
            matches.push(MarkerLine {
                bytes: trim_trailing_cr(&bytes[line_start..line_end]),
                marker_index: marker_index - line_start,
                marker_id,
            });
            search_start = marker_index + marker.len();
        }
    }

    matches.sort_unstable_by(|left, right| {
        let left_start = line_start_ptr(bytes, left.bytes);
        let right_start = line_start_ptr(bytes, right.bytes);
        left_start
            .cmp(&right_start)
            .then(left.marker_index.cmp(&right.marker_index))
            .then(left.marker_id.cmp(&right.marker_id))
    });
    matches.dedup_by(|right, left| std::ptr::eq(left.bytes.as_ptr(), right.bytes.as_ptr()));
    matches
}

#[inline]
pub fn contains(bytes: &[u8], needle: &[u8]) -> bool {
    Finder::new(needle).find(bytes).is_some()
}

#[inline]
fn split_next_line(bytes: &[u8]) -> (&[u8], &[u8]) {
    if let Some(newline) = memchr(b'\n', bytes) {
        let (line, rest) = bytes.split_at(newline);
        (line, &rest[1..])
    } else {
        (bytes, &[])
    }
}

#[inline]
fn line_start_before(bytes: &[u8], index: usize) -> usize {
    memrchr(b'\n', &bytes[..index]).map_or(0, |line_end| line_end + 1)
}

#[inline]
fn line_end_after(bytes: &[u8], index: usize) -> usize {
    index + memchr(b'\n', &bytes[index..]).unwrap_or(bytes.len() - index)
}

#[inline]
fn trim_trailing_cr(bytes: &[u8]) -> &[u8] {
    bytes.strip_suffix(b"\r").unwrap_or(bytes)
}

#[inline]
fn line_start_ptr(haystack: &[u8], line: &[u8]) -> usize {
    line.as_ptr() as usize - haystack.as_ptr() as usize
}

#[cfg(test)]
mod tests {
    use super::{byte_lines, lines, lines_with_any_marker, lines_with_marker};

    #[test]
    fn byte_lines_returns_newline_delimited_slices() {
        let lines = byte_lines(b"one\ntwo\nthree").collect::<Vec<_>>();

        assert_eq!(
            lines,
            [b"one".as_slice(), b"two".as_slice(), b"three".as_slice()]
        );
    }

    #[test]
    fn lines_splits_lf_and_trims_cr() {
        let lines = lines(b"{\"a\":1}\r\n{\"b\":2}\n{\"c\":3}")
            .map(|line| line.bytes)
            .collect::<Vec<_>>();

        assert_eq!(lines, [b"{\"a\":1}".as_slice(), b"{\"b\":2}", b"{\"c\":3}"]);
    }

    #[test]
    fn lines_supports_reverse_iteration() {
        let lines = lines(b"{\"a\":1}\r\n{\"b\":2}\n{\"c\":3}\n")
            .rev()
            .map(|line| line.bytes)
            .collect::<Vec<_>>();

        assert_eq!(lines, [b"{\"c\":3}".as_slice(), b"{\"b\":2}", b"{\"a\":1}"]);
    }

    #[test]
    fn marker_lines_decode_only_matching_lines() {
        let input = b"{\"type\":\"noise\"}\n{\"usage\":{\"input\":1}}\n{\"type\":\"other\"}\n";
        let lines = lines_with_marker(input, br#""usage":{"#)
            .map(|line| (line.bytes, line.marker_index))
            .collect::<Vec<_>>();

        assert_eq!(lines, [(b"{\"usage\":{\"input\":1}}".as_slice(), 1)]);
    }

    #[test]
    fn marker_lines_ignore_empty_marker() {
        let lines = lines_with_marker(b"{\"a\":1}\n", b"").collect::<Vec<_>>();

        assert!(lines.is_empty());
    }

    #[test]
    fn any_marker_returns_file_order_and_dedupes_lines() {
        let input = b"{\"type\":\"turn_context\"}\n{\"payload\":{\"type\":\"token_count\"}}\n";
        let lines = lines_with_any_marker(input, &[b"token_count", b"turn_context", b"type"])
            .into_iter()
            .map(|line| line.bytes)
            .collect::<Vec<_>>();

        assert_eq!(
            lines,
            [
                b"{\"type\":\"turn_context\"}".as_slice(),
                b"{\"payload\":{\"type\":\"token_count\"}}".as_slice(),
            ]
        );
    }
}
