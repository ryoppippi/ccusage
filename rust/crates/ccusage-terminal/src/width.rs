use unicode_width::UnicodeWidthChar;

pub(crate) fn visible_width(value: &str) -> usize {
    let bytes = value.as_bytes();
    let mut width = 0;
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == 0x1b {
            index += 1;
            if index < bytes.len() && bytes[index] == b'[' {
                index += 1;
                while index < bytes.len() && !(bytes[index] as char).is_ascii_alphabetic() {
                    index += 1;
                }
                index += usize::from(index < bytes.len());
            }
            continue;
        }
        let Some(ch) = value[index..].chars().next() else {
            break;
        };
        width += char_display_width(ch);
        index += ch.len_utf8();
    }
    width
}

pub(crate) fn contains_ansi(value: &str) -> bool {
    value.as_bytes().contains(&0x1b)
}

pub(crate) fn char_display_width(ch: char) -> usize {
    UnicodeWidthChar::width(ch).unwrap_or(0)
}

pub(crate) fn visible_width_max_line(value: &str) -> usize {
    value.lines().map(visible_width).max().unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn visible_width_handles_combining_marks_and_cjk() {
        assert_eq!(visible_width("e\u{0301}"), 1);
        assert_eq!(visible_width("表"), 2);
    }

    #[test]
    fn char_display_width_handles_standard_width_cases() {
        assert_eq!(char_display_width('a'), 1);
        assert_eq!(char_display_width('表'), 2);
        assert_eq!(char_display_width('\u{0301}'), 0);
        assert_eq!(char_display_width('\x07'), 0);
        assert_eq!(char_display_width('±'), 1);
    }
}
