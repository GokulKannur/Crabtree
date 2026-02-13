// ============================================
// CRAB TREE — JSON Tree Viewer
// ============================================

export class JsonViewer {
    constructor(container) {
        this.container = container;
    }

    render(data) {
        this.container.innerHTML = '';
        const tree = this.createNode(null, data, true, []); // Root node
        this.container.appendChild(tree);
    }

    createNode(key, value, isLast = false, parentPath = []) {
        const type = this.getType(value);
        const isObject = type === 'object' || type === 'array';
        const isEmpty = isObject && Object.keys(value).length === 0;
        const currentPath = key === null ? parentPath : [...parentPath, String(key)];

        const node = document.createElement('div');
        node.className = 'json-node';
        node.dataset.path = currentPath.map(encodeURIComponent).join('/');

        // 1. Line content (Key : Value)
        const line = document.createElement('div');
        line.className = 'json-line';

        // Toggle Arrow
        if (isObject && !isEmpty) {
            const arrow = document.createElement('span');
            arrow.className = 'json-arrow expanded';
            arrow.textContent = '▼';
            arrow.onclick = (e) => {
                e.stopPropagation();
                this.togglenode(node, arrow);
            };
            line.appendChild(arrow);

            // Allow clicking the key to toggle too
            line.style.cursor = 'pointer';
            line.onclick = (e) => {
                e.stopPropagation();
                this.togglenode(node, arrow);
            };
        } else {
            const spacer = document.createElement('span');
            spacer.className = 'json-spacer';
            line.appendChild(spacer);
        }

        // Key
        if (key !== null) {
            const keySpan = document.createElement('span');
            keySpan.className = 'json-key';
            keySpan.textContent = `"${key}": `;
            line.appendChild(keySpan);
        }

        // Value
        if (isObject) {
            const openChar = type === 'array' ? '[' : '{';
            const closeChar = type === 'array' ? ']' : '}';
            const count = Object.keys(value).length;

            const typeSpan = document.createElement('span');
            typeSpan.className = 'json-bracket';

            if (isEmpty) {
                typeSpan.textContent = `${openChar}${closeChar}`;
                line.appendChild(typeSpan);
            } else {
                typeSpan.textContent = openChar;

                const sizeSpan = document.createElement('span');
                sizeSpan.className = 'json-size';
                sizeSpan.textContent = ` ${count} items `;

                const closeSpan = document.createElement('span');
                closeSpan.className = 'json-bracket json-close-preview hidden';
                closeSpan.textContent = closeChar;

                line.appendChild(typeSpan);
                line.appendChild(sizeSpan); // Collapsed preview
                line.appendChild(closeSpan);
            }
        } else {
            const valSpan = document.createElement('span');
            valSpan.className = `json-value json-${type}`;
            valSpan.textContent = this.formatValue(value, type);
            line.appendChild(valSpan);
        }

        // Comma
        if (!isLast) {
            const comma = document.createElement('span');
            comma.className = 'json-comma';
            comma.textContent = ',';
            line.appendChild(comma);
        }

        node.appendChild(line);

        // 2. Children Container
        if (isObject && !isEmpty) {
            const childrenDiv = document.createElement('div');
            childrenDiv.className = 'json-children';

            const keys = Object.keys(value);
            keys.forEach((k, index) => {
                const childNode = this.createNode(k, value[k], index === keys.length - 1, currentPath);
                childrenDiv.appendChild(childNode);
            });

            // Closing bracket for expanded view
            const closingDiv = document.createElement('div');
            closingDiv.className = 'json-line';
            const spacer = document.createElement('span');
            spacer.className = 'json-spacer';
            const bracket = document.createElement('span');
            bracket.className = 'json-bracket';
            bracket.textContent = type === 'array' ? ']' : '}';

            if (!isLast) {
                const comma = document.createElement('span');
                comma.className = 'json-comma';
                comma.textContent = ',';
                bracket.appendChild(comma);
            }

            closingDiv.appendChild(spacer);
            closingDiv.appendChild(bracket);

            childrenDiv.appendChild(closingDiv);
            node.appendChild(childrenDiv);
        }

        return node;
    }

    togglenode(node, arrow) {
        const children = node.querySelector('.json-children');
        const size = node.querySelector('.json-size');
        const closePreview = node.querySelector('.json-close-preview');

        if (children.classList.contains('hidden')) {
            // Expand
            children.classList.remove('hidden');
            arrow.classList.add('expanded');
            arrow.textContent = '▼';
            if (size) size.classList.remove('visible');
            if (closePreview) closePreview.classList.add('hidden');
        } else {
            // Collapse
            children.classList.add('hidden');
            arrow.classList.remove('expanded');
            arrow.textContent = '▶';
            if (size) size.classList.add('visible');
            if (closePreview) closePreview.classList.remove('hidden');
        }
    }

    getType(value) {
        if (value === null) return 'null';
        if (Array.isArray(value)) return 'array';
        return typeof value;
    }

    formatValue(value, type) {
        if (type === 'string') return `"${value}"`;
        return String(value);
    }
}
