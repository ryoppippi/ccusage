use std::{
    env,
    io::{self, IsTerminal},
};

#[cfg(unix)]
use std::os::fd::AsRawFd;

const DEFAULT_TERMINAL_WIDTH: usize = 120;

#[cfg(all(unix, target_os = "macos"))]
const TIOCGWINSZ: usize = 0x4008_7468;
#[cfg(all(unix, target_os = "linux"))]
const TIOCGWINSZ: usize = 0x5413;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Align {
    Left,
    Right,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Color {
    Blue,
    Green,
    Grey,
    Red,
    Yellow,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct TerminalStyle {
    pub color: bool,
    pub log_level: Option<u8>,
    pub no_color: bool,
}

pub struct SimpleTable {
    headers: Vec<String>,
    aligns: Vec<Align>,
    rows: Vec<Option<Vec<String>>>,
    style: TerminalStyle,
    terminal_width: usize,
    compact_dates: bool,
}

impl SimpleTable {
    pub fn new(headers: Vec<&str>, aligns: Vec<Align>, style: impl Into<TerminalStyle>) -> Self {
        Self {
            headers: headers.into_iter().map(str::to_string).collect(),
            aligns,
            rows: Vec::new(),
            style: style.into(),
            terminal_width: DEFAULT_TERMINAL_WIDTH,
            compact_dates: false,
        }
    }

    pub fn with_terminal_width(mut self, width: usize) -> Self {
        self.terminal_width = width;
        self
    }

    pub fn with_date_compaction(mut self, compact_dates: bool) -> Self {
        self.compact_dates = compact_dates;
        self
    }

    pub fn push(&mut self, row: Vec<String>) {
        self.rows.push(Some(row));
    }

    pub fn separator(&mut self) {
        self.rows.push(None);
    }

    pub fn column_count(&self) -> usize {
        self.headers.len()
    }

    pub fn print(&self) {
        let widths = self.column_widths();
        println!("{}", border('┌', '┬', '┐', &widths));
        for header_row in expand_multiline_row(&self.headers, self.headers.len(), &widths) {
            let header_row = header_row
                .iter()
                .map(|header| color(self.style, header, Color::Blue))
                .collect::<Vec<_>>();
            println!("{}", table_line(&header_row, &self.aligns, &widths));
        }
        println!("{}", border('├', '┼', '┤', &widths));
        for (row_index, row) in self.rows.iter().enumerate() {
            match row {
                Some(row) => {
                    let row = self.compact_date_row(row, &widths);
                    for physical_row in expand_multiline_row(&row, self.headers.len(), &widths) {
                        println!("{}", table_line(&physical_row, &self.aligns, &widths));
                    }
                }
                None => println!("{}", border('├', '┼', '┤', &widths)),
            }
            if row.is_some()
                && row_index + 1 < self.rows.len()
                && !matches!(self.rows.get(row_index + 1), Some(None))
            {
                println!("{}", border('├', '┼', '┤', &widths));
            }
        }
        println!("{}", border('└', '┴', '┘', &widths));
    }

    fn column_widths(&self) -> Vec<usize> {
        let content_widths = self
            .headers
            .iter()
            .enumerate()
            .map(|(index, header)| {
                if index == 1 {
                    visible_width_sum(header)
                } else {
                    visible_width_max_line(header)
                }
            })
            .collect::<Vec<_>>();
        let mut content_widths = content_widths;
        for row in self.rows.iter().flatten() {
            for (index, cell) in row.iter().enumerate() {
                let cell_width = if index == 1 {
                    visible_width_sum(cell)
                } else {
                    visible_width_max_line(cell)
                };
                if let Some(width) = content_widths.get_mut(index) {
                    *width = (*width).max(cell_width);
                }
            }
        }
        let widths = content_widths
            .iter()
            .enumerate()
            .map(|(index, width)| {
                if self.aligns.get(index) == Some(&Align::Right) {
                    (width + 3).max(11)
                } else if index == 1 {
                    (width + 2).max(15)
                } else {
                    (width + 2).max(10)
                }
            })
            .collect::<Vec<_>>();
        let total_required = cli_table_required_width(&widths);
        let first_column_min = if self.compact_dates { 12 } else { 10 };
        let mut widths =
            fit_widths_to_terminal(widths, &self.aligns, self.terminal_width, first_column_min);
        if self.compact_dates && total_required > self.terminal_width {
            if let Some(width) = widths.first_mut() {
                *width = (*width).max(10);
            }
        }
        widths
    }

    fn compact_date_row(&self, row: &[String], widths: &[usize]) -> Vec<String> {
        if !self.compact_dates || widths.first().copied().unwrap_or_default() > 10 {
            return row.to_vec();
        }
        let mut row = row.to_vec();
        if let Some(first) = row.first_mut() {
            if let Some(compact) = compact_date_cell(first) {
                *first = compact;
            }
        }
        row
    }
}

fn expand_multiline_row(row: &[String], column_count: usize, widths: &[usize]) -> Vec<Vec<String>> {
    let cells = (0..column_count)
        .map(|index| {
            let content_width = widths
                .get(index)
                .copied()
                .unwrap_or_default()
                .saturating_sub(2);
            row.get(index)
                .map(|cell| wrap_cell_lines(cell, content_width))
                .filter(|lines| !lines.is_empty())
                .unwrap_or_else(|| vec![String::new()])
        })
        .collect::<Vec<_>>();
    let height = cells.iter().map(Vec::len).max().unwrap_or(1);
    (0..height)
        .map(|line_index| {
            cells
                .iter()
                .map(|lines| lines.get(line_index).cloned().unwrap_or_default())
                .collect::<Vec<_>>()
        })
        .collect()
}

fn fit_widths_to_terminal(
    mut widths: Vec<usize>,
    aligns: &[Align],
    terminal_width: usize,
    first_column_min: usize,
) -> Vec<usize> {
    if cli_table_required_width(&widths) <= terminal_width {
        return widths;
    }

    let minimums = widths
        .iter()
        .enumerate()
        .map(|(index, _)| {
            if aligns.get(index) == Some(&Align::Right) {
                10
            } else if index == 0 {
                first_column_min
            } else if index == 1 {
                12
            } else {
                8
            }
        })
        .collect::<Vec<_>>();

    let available_width = terminal_width.saturating_sub(widths.len() + 1);
    let total_content_width = widths.iter().sum::<usize>();
    if total_content_width > 0 {
        let scale = available_width as f64 / total_content_width as f64;
        for (index, width) in widths.iter_mut().enumerate() {
            let scaled = (*width as f64 * scale).floor() as usize;
            *width = scaled.max(minimums[index]);
        }
    }

    while cli_table_required_width(&widths) > terminal_width {
        let Some(index) = widths
            .iter()
            .enumerate()
            .filter(|(index, width)| **width > minimums[*index])
            .max_by_key(|(_, width)| **width)
            .map(|(index, _)| index)
        else {
            break;
        };
        widths[index] -= 1;
    }
    widths
}

fn cli_table_required_width(widths: &[usize]) -> usize {
    widths.iter().sum::<usize>() + widths.len() + 1
}

fn wrap_cell_lines(cell: &str, width: usize) -> Vec<String> {
    if width == 0 {
        return vec![String::new()];
    }
    let mut lines = Vec::new();
    for line in cell.lines() {
        if visible_width(line) <= width {
            lines.push(line.to_string());
            continue;
        }
        lines.extend(wrap_cell_line(line, width));
    }
    lines
}

fn wrap_cell_line(line: &str, width: usize) -> Vec<String> {
    if line.split_whitespace().count() <= 1 {
        return vec![truncate_visible(line, width)];
    }

    let mut lines = Vec::new();
    let mut current = String::new();
    for word in line.split_whitespace() {
        let candidate_width = if current.is_empty() {
            visible_width(word)
        } else {
            visible_width(&current) + 1 + visible_width(word)
        };
        if candidate_width <= width {
            if !current.is_empty() {
                current.push(' ');
            }
            current.push_str(word);
        } else {
            if !current.is_empty() {
                lines.push(current);
            }
            current = if visible_width(word) > width {
                truncate_visible(word, width)
            } else {
                word.to_string()
            };
        }
    }
    if !current.is_empty() {
        lines.push(current);
    }
    lines
}

fn truncate_visible(value: &str, width: usize) -> String {
    if visible_width(value) <= width {
        return value.to_string();
    }
    if width <= 1 {
        return "…".to_string();
    }
    let mut output = String::new();
    let mut current_width = 0;
    let mut index = 0;
    let bytes = value.as_bytes();
    while index < bytes.len() {
        if bytes[index] == 0x1b {
            let start = index;
            index += 1;
            if index < bytes.len() && bytes[index] == b'[' {
                index += 1;
                while index < bytes.len() && !(bytes[index] as char).is_ascii_alphabetic() {
                    index += 1;
                }
                if index < bytes.len() {
                    index += 1;
                }
            }
            output.push_str(&value[start..index]);
            continue;
        }
        let Some(ch) = value[index..].chars().next() else {
            break;
        };
        let char_width = char_display_width(ch);
        if current_width + char_width >= width {
            break;
        }
        output.push(ch);
        current_width += char_width;
        index += ch.len_utf8();
    }
    if contains_ansi(value) && !output.ends_with("\x1b[0m") {
        output.push_str("\x1b[0m");
    }
    output.push('…');
    output
}

fn compact_date_cell(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    if bytes.len() == 10
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes[..4].iter().all(u8::is_ascii_digit)
        && bytes[5..7].iter().all(u8::is_ascii_digit)
        && bytes[8..10].iter().all(u8::is_ascii_digit)
    {
        Some(format!("{}\n{}", &value[..4], &value[5..]))
    } else {
        None
    }
}

fn table_line(cells: &[String], aligns: &[Align], widths: &[usize]) -> String {
    let mut line = String::from("│");
    for (index, width) in widths.iter().enumerate() {
        let cell = cells.get(index).map(String::as_str).unwrap_or("");
        let align = if index == 0 && cell.starts_with("(assuming ") {
            Align::Right
        } else {
            aligns.get(index).copied().unwrap_or(Align::Left)
        };
        line.push(' ');
        line.push_str(&pad_cell(cell, width.saturating_sub(2), align));
        line.push(' ');
        line.push('│');
    }
    line
}

fn pad_cell(cell: &str, width: usize, align: Align) -> String {
    let visible = visible_width(cell);
    if visible >= width {
        return cell.to_string();
    }
    let padding = width - visible;
    match align {
        Align::Left => format!("{cell}{}", " ".repeat(padding)),
        Align::Right => format!("{}{cell}", " ".repeat(padding)),
    }
}

fn border(left: char, middle: char, right: char, widths: &[usize]) -> String {
    let mut line = String::new();
    line.push(left);
    for (index, width) in widths.iter().enumerate() {
        line.push_str(&"─".repeat(*width));
        line.push(if index + 1 == widths.len() {
            right
        } else {
            middle
        });
    }
    line
}

fn visible_width(value: &str) -> usize {
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

fn contains_ansi(value: &str) -> bool {
    value.as_bytes().contains(&0x1b)
}

fn char_display_width(ch: char) -> usize {
    if ch.is_ascii() {
        1
    } else {
        2
    }
}

fn visible_width_max_line(value: &str) -> usize {
    value.lines().map(visible_width).max().unwrap_or_default()
}

fn visible_width_sum(value: &str) -> usize {
    value.lines().map(visible_width).sum()
}

pub fn terminal_width() -> usize {
    env::var("COLUMNS")
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .filter(|width| *width > 0)
        .or_else(terminal_width_from_ioctl)
        .unwrap_or(DEFAULT_TERMINAL_WIDTH)
}

#[cfg(unix)]
fn terminal_width_from_ioctl() -> Option<usize> {
    if !io::stdout().is_terminal() {
        return None;
    }
    #[repr(C)]
    struct Winsize {
        rows: u16,
        cols: u16,
        xpixel: u16,
        ypixel: u16,
    }
    let mut size = Winsize {
        rows: 0,
        cols: 0,
        xpixel: 0,
        ypixel: 0,
    };
    let rc = unsafe { ioctl(io::stdout().as_raw_fd(), TIOCGWINSZ, &mut size) };
    if rc == 0 && size.cols > 0 {
        Some(size.cols as usize)
    } else {
        None
    }
}

#[cfg(not(unix))]
fn terminal_width_from_ioctl() -> Option<usize> {
    None
}

#[cfg(unix)]
extern "C" {
    fn ioctl(fd: i32, request: usize, ...) -> i32;
}

pub fn print_box_title(title: &str, style: impl Into<TerminalStyle>) {
    let style = style.into();
    if style.log_level == Some(0) {
        return;
    }
    for line in box_title_lines(title, style) {
        println!("{line}");
    }
}

pub fn color(style: impl Into<TerminalStyle>, value: impl AsRef<str>, color: Color) -> String {
    let style = style.into();
    let value = value.as_ref();
    if !use_color(&style) {
        return value.to_string();
    }
    let code = match color {
        Color::Blue => 34,
        Color::Green => 32,
        Color::Grey => 90,
        Color::Red => 31,
        Color::Yellow => 33,
    };
    format!("\x1b[{code}m{value}\x1b[0m")
}

fn use_color(style: &TerminalStyle) -> bool {
    if style.no_color || env::var_os("NO_COLOR").is_some() {
        return false;
    }
    style.color || env::var_os("FORCE_COLOR").is_some() || io::stdout().is_terminal()
}

fn box_title_lines(title: &str, style: TerminalStyle) -> Vec<String> {
    let title_lines = title.lines().collect::<Vec<_>>();
    let content_width = title_lines
        .iter()
        .map(|line| visible_width(line))
        .max()
        .unwrap_or_default()
        .max(40)
        + 2;
    let mut lines = Vec::with_capacity(title_lines.len() + 5);
    lines.push(String::new());
    lines.push(format!("╭{}╮", "─".repeat(content_width + 2)));
    lines.push(format!("│{}│", " ".repeat(content_width + 2)));
    for line in title_lines {
        let padding = content_width.saturating_sub(visible_width(line));
        let left_padding = padding / 2;
        let right_padding = padding - left_padding;
        lines.push(format!(
            "│ {}{}{} │",
            " ".repeat(left_padding),
            color(style, line, Color::Blue),
            " ".repeat(right_padding)
        ));
    }
    lines.push(format!("│{}│", " ".repeat(content_width + 2)));
    lines.push(format!("╰{}╯", "─".repeat(content_width + 2)));
    lines.push(String::new());
    lines
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn color_respects_explicit_no_color() {
        let style = TerminalStyle {
            color: true,
            log_level: None,
            no_color: true,
        };

        assert_eq!(color(style, "Total", Color::Yellow), "Total");
    }

    #[test]
    fn box_title_lines_render_multiline_content_in_one_box() {
        let lines = box_title_lines(
            "Coding (Agent) CLI Usage Report - Daily\nDetected: Claude, Codex",
            TerminalStyle {
                no_color: true,
                ..TerminalStyle::default()
            },
        );

        assert!(lines.iter().any(|line| line.contains(
            "Coding (Agent) CLI Usage Report - Daily"
        )));
        assert!(lines
            .iter()
            .any(|line| line.contains("Detected: Claude, Codex")));
        assert_eq!(lines.iter().filter(|line| line.starts_with('╭')).count(), 1);
        assert_eq!(lines.iter().filter(|line| line.starts_with('╰')).count(), 1);
    }

    #[test]
    fn compact_date_cell_splits_iso_dates() {
        assert_eq!(
            compact_date_cell("2026-05-18"),
            Some("2026\n05-18".to_string())
        );
        assert_eq!(compact_date_cell("20260518"), None);
    }

    #[test]
    fn width_fitting_keeps_table_within_terminal_when_possible() {
        let widths = fit_widths_to_terminal(
            vec![20, 40, 14, 14],
            &[Align::Left, Align::Left, Align::Right, Align::Right],
            60,
            12,
        );

        assert!(cli_table_required_width(&widths) <= 60);
    }

    #[test]
    fn truncate_visible_preserves_ansi_reset() {
        let truncated = truncate_visible("\x1b[33mvery-long-value\x1b[0m", 8);

        assert!(truncated.ends_with("\x1b[0m…"));
    }
}
