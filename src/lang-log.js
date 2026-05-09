// ============================================
// CRAB TREE — Log File Language Definition
// ============================================

import { StreamLanguage } from '@codemirror/language';

// Regex Patterns
const RE_DATE = /^\d{4}-\d{2}-\d{2}/;
const RE_TIME = /^\d{2}:\d{2}:\d{2}(?:\.\d+)?/;
const RE_IP = /\b(?:[0-9]{1,3}\.){3}[0-9]{1,3}\b/;
const RE_SEVERITY_ERR = /\b(ERROR|FATAL|CRITICAL|FAIL|Failed)\b/i;
const RE_SEVERITY_WARN = /\b(WARN|WARNING)\b/i;
const RE_SEVERITY_INFO = /\b(INFO|DEBUG|TRACE)\b/i;
const RE_GUID = /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/;
const RE_QUOTED = /"[^"]*"/;
const RE_BRACKETS = /\[.*?\]/;

const tokenLogic = {
    token(stream) {
        // Eat whitespace
        if (stream.eatSpace()) return null;

        // Severity
        if (stream.match(RE_SEVERITY_ERR)) return 'log-error';
        if (stream.match(RE_SEVERITY_WARN)) return 'log-warn';
        if (stream.match(RE_SEVERITY_INFO)) return 'log-info';

        // Date/Time
        if (stream.match(RE_DATE)) return 'log-date';
        if (stream.match(RE_TIME)) return 'log-time';

        // Constants
        if (stream.match(RE_IP)) return 'log-constant';
        if (stream.match(RE_GUID)) return 'log-constant';

        // Structure
        if (stream.match(RE_BRACKETS)) return 'log-bracket';
        if (stream.match(RE_QUOTED)) return 'string';

        // Skip to next separator or end of line
        stream.next();
        return null;
    }
};

export const logLanguage = StreamLanguage.define(tokenLogic);
