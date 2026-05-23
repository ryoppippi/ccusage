use std::{
    env,
    io::{self, IsTerminal},
};

#[cfg(unix)]
use std::os::fd::AsRawFd;

pub(crate) const DEFAULT_TERMINAL_WIDTH: usize = 120;

#[cfg(all(unix, target_os = "macos"))]
const TIOCGWINSZ: usize = 0x4008_7468;
#[cfg(all(unix, target_os = "linux"))]
const TIOCGWINSZ: usize = 0x5413;

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
