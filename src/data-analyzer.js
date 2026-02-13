export class DataAnalyzer {
    static analyze(content, language) {
        const nonEmptyLineCount = content.split(/\r?\n/).filter(line => line.trim().length > 0).length;
        const stats = {
            lines: nonEmptyLineCount,
            size: new Blob([content]).size,
            type: language,
            insights: []
        };

        if (language === 'json' || content.trim().startsWith('{') || content.trim().startsWith('[')) {
            this.analyzeJson(content, stats);
        } else if (language === 'log' || language === 'plaintext') {
            this.analyzeLog(content, stats);
        } else {
            this.analyzeCode(content, stats);
        }

        return stats;
    }

    static detectSecrets(content) {
        const findings = [];
        
        // 🔐 Sensitive key names (high confidence)
        const sensitiveKeys = /(?:"(?:password|secret|api[_-]?key|private[_-]?key|secret[_-]?key|auth[_-]?token|access[_-]?token|refresh[_-]?token|oauth[_-]?token|jwt|bearer|credential|aws[_-]?secret|azure[_-]?key|gcp[_-]?)?key")/gi;
        if (sensitiveKeys.test(content)) {
            findings.push('Sensitive key names detected (password, secret, token, etc.)');
        }
        
        // 🔐 AWS-style access key (AKIA + 16 alphanumeric)
        if (/AKIA[0-9A-Z]{16}/.test(content)) {
            findings.push('AWS Access Key ID detected');
        }
        
        // 🔐 AWS-style secret (likely 40 chars base64)
        if (/[A-Za-z0-9\/+=]{40}/.test(content)) {
            findings.push('High-entropy secret-like value detected');
        }
        
        // 🔐 JWT tokens (header.payload.signature)
        if (/eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.test(content)) {
            findings.push('JWT token detected');
        }
        
        // 🔐 Private key headers
        if (/-----BEGIN (RSA |DSA |EC |PGP )?PRIVATE KEY-----/.test(content)) {
            findings.push('Private key detected');
        }
        
        // 🔐 Certificates
        if (/-----BEGIN CERTIFICATE-----/.test(content)) {
            findings.push('X.509 certificate detected');
        }
        
        return findings;
    }

    static analyzeJson(content, stats) {
        try {
            const data = JSON.parse(content);
            stats.type = 'JSON Data';

            const countKeys = (obj) => {
                let count = 0;
                if (typeof obj === 'object' && obj !== null) {
                    count += Object.keys(obj).length;
                    Object.values(obj).forEach(v => count += countKeys(v));
                }
                return count;
            };

            const keys = countKeys(data);
            stats.insights.push(`Found <strong>${keys}</strong> total properties`);

            const depth = (obj) => {
                let level = 1;
                if (typeof obj === 'object' && obj !== null) {
                    for (const key in obj) {
                        if (typeof obj[key] === 'object' && obj[key] !== null) {
                            const d = depth(obj[key]) + 1;
                            if (d > level) level = d;
                        }
                    }
                }
                return level;
            };
            stats.insights.push(`Max nesting depth: <strong>${depth(data)}</strong>`);

            // Enhanced sensitive data detection
            const secrets = this.detectSecrets(content);
            if (secrets.length > 0) {
                stats.insights.push(`⚠️ <strong>Potential secrets:</strong> ${secrets.join(', ')}`);
            }
        } catch (e) {
            stats.insights.push(`Invalid JSON: ${e.message}`);
        }
    }

    static analyzeLog(content, stats) {
        stats.type = 'Log File';

        const lines = content.split(/\r?\n/).filter(line => line.trim().length > 0);
        let errorCount = 0;
        let warnCount = 0;

        for (const line of lines) {
            // Use one explicit severity token per line to avoid counting words
            // like "failed" or "failover" as additional errors.
            const severityMatch = line.match(/\b(INFO|WARN(?:ING)?|ERROR|DEBUG|TRACE|CRITICAL|FATAL|FAIL)\b/i);
            if (!severityMatch) continue;

            const severity = severityMatch[1].toUpperCase();
            if (severity === 'WARN' || severity === 'WARNING') {
                warnCount += 1;
            } else if (severity === 'ERROR' || severity === 'CRITICAL' || severity === 'FATAL' || severity === 'FAIL') {
                errorCount += 1;
            }
        }

        const ipCount = new Set(content.match(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g) || []).size;

        if (errorCount > 0) stats.insights.push(`<strong>${errorCount}</strong> Errors detected`);
        else stats.insights.push(`No errors found`);

        if (warnCount > 0) stats.insights.push(`<strong>${warnCount}</strong> Warnings detected`);

        if (ipCount > 0) stats.insights.push(`<strong>${ipCount}</strong> unique IP addresses found`);

        // Timestamps may be either "2026-02-13T15:40:12" or "2026-02-13 15:40:12".
        const timestamps = content.match(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/g);
        if (timestamps && timestamps.length > 1) {
            const start = new Date(timestamps[0].replace(' ', 'T'));
            const end = new Date(timestamps[timestamps.length - 1].replace(' ', 'T'));
            if (!Number.isNaN(start.getTime()) && !Number.isNaN(end.getTime())) {
                const diffSeconds = Math.max(0, Math.round((end - start) / 1000));
                if (diffSeconds < 60) {
                    const unit = diffSeconds === 1 ? 'second' : 'seconds';
                    stats.insights.push(`Log span: <strong>${diffSeconds} ${unit}</strong>`);
                } else {
                    const diffMinutes = Math.round(diffSeconds / 60);
                    const unit = diffMinutes === 1 ? 'minute' : 'minutes';
                    stats.insights.push(`Log span: <strong>${diffMinutes} ${unit}</strong>`);
                }
            }
        }
    }

    static analyzeCode(content, stats) {
        const functions = (content.match(/function\s+\w+|const\s+\w+\s*=\s*\(|=>/g) || []).length;
        const comments = (content.match(/\/\/|\/\*|#/g) || []).length;

        stats.insights.push(`<strong>${functions}</strong> potential functions`);
        stats.insights.push(`<strong>${comments}</strong> comment blocks`);

        if (content.length > 50000) stats.insights.push(`Large file: Consider splitting functionality`);
    }
}
