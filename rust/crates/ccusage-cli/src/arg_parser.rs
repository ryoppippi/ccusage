use std::ffi::OsString;

pub(crate) struct ArgParser {
    pub(crate) args: Vec<String>,
    index: usize,
    pending_value: Option<String>,
}

impl ArgParser {
    pub(crate) fn new(args: Vec<OsString>) -> Result<Self, String> {
        let mut parsed = Vec::with_capacity(args.len());
        for arg in args {
            parsed.push(
                arg.into_string()
                    .map_err(|_| "Arguments must be valid UTF-8".to_string())?,
            );
        }
        Ok(Self {
            args: parsed,
            index: 0,
            pending_value: None,
        })
    }

    pub(crate) fn peek(&self) -> Option<&str> {
        self.args.get(self.index).map(String::as_str)
    }

    pub(crate) fn next(&mut self) -> Option<String> {
        let value = self.args.get(self.index)?.clone();
        self.index += 1;
        Some(value)
    }

    pub(crate) fn next_flag(&mut self) -> Result<String, String> {
        let arg = self
            .next()
            .ok_or_else(|| "Expected option but reached end of arguments".to_string())?;
        if let Some((flag, value)) = arg.split_once('=') {
            self.pending_value = Some(value.to_string());
            return Ok(flag.to_string());
        }
        if arg.starts_with('-') {
            Ok(arg)
        } else {
            Err(format!("Expected option, got '{arg}'"))
        }
    }

    pub(crate) fn value_for(&mut self, flag: &str) -> Result<String, String> {
        if let Some(value) = self.pending_value.take() {
            if value.is_empty() {
                return Err(format!("Missing value for {flag}"));
            }
            return Ok(value);
        }
        let value = self
            .next()
            .ok_or_else(|| format!("Missing value for {flag}"))?;
        if value.starts_with('-') {
            return Err(format!("Missing value for {flag}"));
        }
        Ok(value)
    }
}
