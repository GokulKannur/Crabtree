// ============================================
// CRAB TREE — Command Palette & Registry
// ============================================

export class CommandPalette {
    constructor() {
        this.commands = [];
        this.isOpen = false;
        this.selectedIndex = 0;
        this.filteredCommands = [];

        // Create UI on init
        this.createUI();
        this.bindEvents();
    }

    register(id, label, action, shortcut = null) {
        this.commands.push({ id, label, action, shortcut });
    }

    createUI() {
        const overlay = document.createElement('div');
        overlay.id = 'command-palette-overlay';
        overlay.className = 'palette-overlay hidden';

        const container = document.createElement('div');
        container.className = 'palette-container';

        const input = document.createElement('input');
        input.type = 'text';
        input.id = 'palette-input';
        input.placeholder = 'Type a command...';
        input.autocomplete = 'off';

        const list = document.createElement('div');
        list.id = 'palette-list';
        list.className = 'palette-list';

        container.appendChild(input);
        container.appendChild(list);
        overlay.appendChild(container); // Don't append to body yet, main.js can do it or we do it here? 
        // Best to append to body immediately so it exists
        document.body.appendChild(overlay);

        this.overlayEntry = overlay;
        this.inputEntry = input;
        this.listEntry = list;
    }

    bindEvents() {
        // Input handling
        this.inputEntry.addEventListener('input', () => this.filterCommands());

        // Keyboard navigation
        this.inputEntry.addEventListener('keydown', (e) => {
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                if (this.filteredCommands.length > 0) {
                    this.selectedIndex = (this.selectedIndex + 1) % this.filteredCommands.length;
                    this.renderList();
                }
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                if (this.filteredCommands.length > 0) {
                    this.selectedIndex = (this.selectedIndex - 1 + this.filteredCommands.length) % this.filteredCommands.length;
                    this.renderList();
                }
            } else if (e.key === 'Enter') {
                e.preventDefault();
                this.executeSelected();
            } else if (e.key === 'Escape') {
                e.preventDefault();
                this.close();
            }
        });

        // Close on click outside
        this.overlayEntry.addEventListener('click', (e) => {
            if (e.target === this.overlayEntry) this.close();
        });
    }

    open() {
        this.isOpen = true;
        this.overlayEntry.classList.remove('hidden');
        this.inputEntry.value = '';
        this.inputEntry.focus();
        this.filterCommands();
    }

    close() {
        this.isOpen = false;
        this.overlayEntry.classList.add('hidden');
        // Refocus editor if possible (handled by main.js usually)
    }

    filterCommands() {
        const query = this.inputEntry.value.toLowerCase();
        this.filteredCommands = this.commands.filter(cmd =>
            cmd.label.toLowerCase().includes(query)
        );
        this.selectedIndex = 0;
        this.renderList();
    }

    renderList() {
        this.listEntry.innerHTML = '';

        if (this.filteredCommands.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'palette-item empty';
            empty.textContent = 'No matching commands';
            this.listEntry.appendChild(empty);
            return;
        }

        this.filteredCommands.forEach((cmd, index) => {
            const item = document.createElement('div');
            item.className = 'palette-item' + (index === this.selectedIndex ? ' active' : '');

            const label = document.createElement('span');
            label.className = 'palette-label';
            label.textContent = cmd.label;

            item.appendChild(label);

            if (cmd.shortcut) {
                const shortcut = document.createElement('span');
                shortcut.className = 'palette-shortcut';
                shortcut.textContent = cmd.shortcut;
                item.appendChild(shortcut);
            }

            item.addEventListener('click', () => {
                this.selectedIndex = index;
                this.executeSelected();
            });

            // Auto-scroll
            if (index === this.selectedIndex) {
                item.scrollIntoView({ block: 'nearest' });
            }

            this.listEntry.appendChild(item);
        });
    }

    executeSelected() {
        if (this.filteredCommands[this.selectedIndex]) {
            const cmd = this.filteredCommands[this.selectedIndex];
            this.close();
            try {
                cmd.action();
            } catch (err) {
                console.error(`Command error (${cmd.id}):`, err);
                alert(`Command failed: ${err.message}`);
            }
        }
    }
}
