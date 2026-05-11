use std::env;

use unicode_width::{UnicodeWidthChar, UnicodeWidthStr};

#[derive(Clone, Copy)]
pub(crate) enum Align {
    Left,
    Right,
}

#[derive(Clone)]
pub(crate) struct Cell {
    content: String,
}

impl Cell {
    pub(crate) fn new(content: impl Into<String>) -> Self {
        Self {
            content: content.into(),
        }
    }
}

pub(crate) struct Table {
    headers: Vec<String>,
    aligns: Vec<Align>,
    rows: Vec<Vec<Cell>>,
    color: bool,
}

impl Table {
    pub(crate) fn new(headers: Vec<&str>, aligns: Vec<Align>, color: bool) -> Self {
        Self {
            headers: headers.into_iter().map(str::to_string).collect(),
            aligns,
            rows: Vec::new(),
            color,
        }
    }

    pub(crate) fn push(&mut self, row: Vec<Cell>) {
        self.rows.push(row);
    }

    pub(crate) fn render(&self) -> String {
        let mut widths = self.content_widths();
        fit_widths(&mut widths, terminal_width());

        let mut out = String::new();
        out.push_str(&border_line('┌', '┬', '┐', &widths, self.color));
        out.push('\n');
        for line in render_row(
            &self.headers.iter().map(Cell::new).collect::<Vec<_>>(),
            &widths,
            &self.aligns,
            self.color,
            true,
        ) {
            out.push_str(&line);
            out.push('\n');
        }
        out.push_str(&border_line('├', '┼', '┤', &widths, self.color));
        for (index, row) in self.rows.iter().enumerate() {
            out.push('\n');
            for line in render_row(row, &widths, &self.aligns, self.color, false) {
                out.push_str(&line);
                out.push('\n');
            }
            let is_last = index + 1 == self.rows.len();
            if is_last {
                out.push_str(&border_line('└', '┴', '┘', &widths, self.color));
            } else {
                out.push_str(&border_line('├', '┼', '┤', &widths, self.color));
            }
        }
        out
    }

    fn content_widths(&self) -> Vec<usize> {
        self.headers
            .iter()
            .enumerate()
            .map(|(index, header)| {
                let mut width = visible_width(header);
                for row in &self.rows {
                    let cell = row
                        .get(index)
                        .map(|cell| cell.content.as_str())
                        .unwrap_or("");
                    width = width.max(cell.lines().map(visible_width).max().unwrap_or(0));
                }
                match self.aligns.get(index).copied().unwrap_or(Align::Left) {
                    Align::Right => width.max(7) + 3,
                    Align::Left if index == 1 => width.max(15) + 2,
                    Align::Left => width.max(8) + 2,
                }
            })
            .collect()
    }
}

pub(crate) fn print_box(title: &str) {
    let width = visible_width(title) + 4;
    println!();
    println!(" ╭{}╮", "─".repeat(width));
    println!(" │{}│", " ".repeat(width));
    println!(" │  {title}  │");
    println!(" │{}│", " ".repeat(width));
    println!(" ╰{}╯", "─".repeat(width));
    println!();
}

pub(crate) fn color_enabled(no_color: bool, color: bool) -> bool {
    if no_color || env::var_os("NO_COLOR").is_some() {
        return false;
    }
    color || env::var_os("FORCE_COLOR").is_some() || env::var_os("CI").is_none()
}

pub(crate) fn cyan(value: impl AsRef<str>, color: bool) -> String {
    wrap_color(value.as_ref(), "36", color)
}

pub(crate) fn gray(value: impl AsRef<str>, color: bool) -> String {
    wrap_color(value.as_ref(), "90", color)
}

fn wrap_color(value: &str, code: &str, color: bool) -> String {
    if color {
        format!("\x1b[{code}m{value}\x1b[39m")
    } else {
        value.to_string()
    }
}

fn terminal_width() -> usize {
    env::var("COLUMNS")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(120)
}

fn fit_widths(widths: &mut [usize], terminal_width: usize) {
    let overhead = widths.len() * 3 + 1;
    let available = terminal_width.saturating_sub(overhead);
    let current = widths.iter().sum::<usize>();
    if current <= available || current == 0 {
        return;
    }
    let scale = available as f64 / current as f64;
    for (index, width) in widths.iter_mut().enumerate() {
        let min = if index == 0 {
            8
        } else if index == 1 {
            12
        } else {
            7
        };
        *width = ((*width as f64 * scale).floor() as usize).max(min);
    }
}

fn border_line(left: char, join: char, right: char, widths: &[usize], color: bool) -> String {
    let mut line = String::new();
    line.push(left);
    for (index, width) in widths.iter().enumerate() {
        line.push_str(&"─".repeat(width + 2));
        line.push(if index + 1 == widths.len() {
            right
        } else {
            join
        });
    }
    gray(line, color)
}

fn render_row(
    row: &[Cell],
    widths: &[usize],
    aligns: &[Align],
    color: bool,
    is_header: bool,
) -> Vec<String> {
    let wrapped = widths
        .iter()
        .enumerate()
        .map(|(index, width)| {
            let value = row
                .get(index)
                .map(|cell| cell.content.as_str())
                .unwrap_or("");
            wrap_cell(value, *width)
        })
        .collect::<Vec<_>>();
    let height = wrapped.iter().map(Vec::len).max().unwrap_or(1);
    (0..height)
        .map(|line_index| {
            let mut line = String::new();
            line.push_str(&gray("│", color));
            for (index, width) in widths.iter().enumerate() {
                let content = wrapped[index]
                    .get(line_index)
                    .map(String::as_str)
                    .unwrap_or("");
                let align = aligns.get(index).copied().unwrap_or(Align::Left);
                let padded = pad(content, *width, align);
                let display = if is_header {
                    cyan(padded, color)
                } else {
                    padded
                };
                line.push(' ');
                line.push_str(&display);
                line.push(' ');
                line.push_str(&gray("│", color));
            }
            line
        })
        .collect()
}

fn wrap_cell(value: &str, width: usize) -> Vec<String> {
    let mut lines = Vec::new();
    for line in value.lines() {
        if visible_width(line) <= width {
            lines.push(line.to_string());
        } else {
            lines.push(truncate(line, width));
        }
    }
    if lines.is_empty() {
        lines.push(String::new());
    }
    lines
}

fn pad(value: &str, width: usize, align: Align) -> String {
    let visible = visible_width(value);
    if visible >= width {
        return value.to_string();
    }
    let padding = " ".repeat(width - visible);
    match align {
        Align::Left => format!("{value}{padding}"),
        Align::Right => format!("{padding}{value}"),
    }
}

fn truncate(value: &str, width: usize) -> String {
    if width == 0 {
        return String::new();
    }
    if width == 1 {
        return "…".to_string();
    }
    let mut out = String::new();
    let mut used = 0;
    for ch in value.chars() {
        let ch_width = ch.width().unwrap_or(0);
        if used + ch_width >= width {
            break;
        }
        out.push(ch);
        used += ch_width;
    }
    out.push('…');
    out
}

fn visible_width(value: &str) -> usize {
    UnicodeWidthStr::width(value)
}
