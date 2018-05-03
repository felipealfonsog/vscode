/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import 'vs/css!./media/nextTabsTitleControl';
import { TPromise } from 'vs/base/common/winjs.base';
import { isMacintosh } from 'vs/base/common/platform';
import { shorten } from 'vs/base/common/labels';
import { ActionRunner, IAction } from 'vs/base/common/actions';
import { IEditorInput, Verbosity } from 'vs/platform/editor/common/editor';
import { IEditorGroup, toResource, GroupIdentifier } from 'vs/workbench/common/editor';
import { StandardKeyboardEvent } from 'vs/base/browser/keyboardEvent';
import { EventType as TouchEventType, GestureEvent, Gesture } from 'vs/base/browser/touch';
import { KeyCode } from 'vs/base/common/keyCodes';
import { ResourceLabel } from 'vs/workbench/browser/labels';
import { ActionBar } from 'vs/base/browser/ui/actionbar/actionbar';
import { IContextMenuService } from 'vs/platform/contextview/browser/contextView';
import { IEditorTabOptions } from 'vs/workbench/services/group/common/groupService';
import { ITelemetryService } from 'vs/platform/telemetry/common/telemetry';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { IKeybindingService } from 'vs/platform/keybinding/common/keybinding';
import { IContextKeyService } from 'vs/platform/contextkey/common/contextkey';
import { IMenuService } from 'vs/platform/actions/common/actions';
import { NextTitleControl } from 'vs/workbench/browser/parts/editor2/nextTitleControl';
import { IQuickOpenService } from 'vs/platform/quickOpen/common/quickOpen';
import { IDisposable, dispose, combinedDisposable } from 'vs/base/common/lifecycle';
import { ScrollableElement } from 'vs/base/browser/ui/scrollbar/scrollableElement';
import { ScrollbarVisibility } from 'vs/base/common/scrollable';
import { getOrSet } from 'vs/base/common/map';
import { IThemeService, registerThemingParticipant, ITheme, ICssStyleCollector } from 'vs/platform/theme/common/themeService';
import { TAB_INACTIVE_BACKGROUND, TAB_ACTIVE_BACKGROUND, TAB_ACTIVE_FOREGROUND, TAB_INACTIVE_FOREGROUND, TAB_BORDER, EDITOR_DRAG_AND_DROP_BACKGROUND, TAB_UNFOCUSED_ACTIVE_FOREGROUND, TAB_UNFOCUSED_INACTIVE_FOREGROUND, TAB_UNFOCUSED_ACTIVE_BORDER, TAB_ACTIVE_BORDER, TAB_HOVER_BACKGROUND, TAB_HOVER_BORDER, TAB_UNFOCUSED_HOVER_BACKGROUND, TAB_UNFOCUSED_HOVER_BORDER, EDITOR_GROUP_HEADER_TABS_BACKGROUND, EDITOR_GROUP_BACKGROUND, WORKBENCH_BACKGROUND } from 'vs/workbench/common/theme';
import { activeContrastBorder, contrastBorder, editorBackground } from 'vs/platform/theme/common/colorRegistry';
import { ResourcesDropHandler, fillResourceDataTransfers, LocalSelectionTransfer, DraggedEditorIdentifier } from 'vs/workbench/browser/dnd';
import { Color } from 'vs/base/common/color';
import { INotificationService } from 'vs/platform/notification/common/notification';
import { IExtensionService } from 'vs/workbench/services/extensions/common/extensions';
import { INextEditorGroup } from 'vs/workbench/services/editor/common/nextEditorGroupsService';
import { IGroupsAccessor } from 'vs/workbench/browser/parts/editor2/nextEditorGroupView';
import { IUntitledEditorService } from 'vs/workbench/services/untitled/common/untitledEditorService';
import { addClass, addDisposableListener, hasClass, EventType, EventHelper, removeClass, clearNode, Dimension, scheduleAtNextAnimationFrame, findParentWithClass } from 'vs/base/browser/dom';
import { localize } from 'vs/nls';

interface IEditorInputLabel {
	name: string;
	description?: string;
	title?: string;
}

type AugmentedLabel = IEditorInputLabel & { editor: IEditorInput };

export class NextTabsTitleControl extends NextTitleControl {

	private titleContainer: HTMLElement;
	private tabsContainer: HTMLElement;
	private editorToolbarContainer: HTMLElement;
	private scrollbar: ScrollableElement;

	private activeTab: HTMLElement;
	private tabLabelWidgets: ResourceLabel[] = [];
	private tabLabels: IEditorInputLabel[] = [];
	private tabDisposeables: IDisposable[] = [];

	private dimension: Dimension;
	private layoutScheduled: IDisposable;
	private blockRevealActiveTab: boolean;

	private transfer = LocalSelectionTransfer.getInstance<DraggedEditorIdentifier>();

	constructor(
		parent: HTMLElement,
		groupsAccessor: IGroupsAccessor,
		group: INextEditorGroup,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IUntitledEditorService private untitledEditorService: IUntitledEditorService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IKeybindingService keybindingService: IKeybindingService,
		@ITelemetryService telemetryService: ITelemetryService,
		@INotificationService notificationService: INotificationService,
		@IMenuService menuService: IMenuService,
		@IQuickOpenService quickOpenService: IQuickOpenService,
		@IThemeService themeService: IThemeService,
		@IExtensionService extensionService: IExtensionService
	) {
		super(parent, groupsAccessor, group, contextMenuService, instantiationService, contextKeyService, keybindingService, telemetryService, notificationService, menuService, quickOpenService, themeService, extensionService);
	}

	protected create(parent: HTMLElement): void {
		this.titleContainer = parent;

		// Tabs Container
		this.tabsContainer = document.createElement('div');
		this.tabsContainer.setAttribute('role', 'tablist');
		addClass(this.tabsContainer, 'tabs-container');

		// Forward scrolling inside the container to our custom scrollbar
		this._register(addDisposableListener(this.tabsContainer, EventType.SCROLL, e => {
			if (hasClass(this.tabsContainer, 'scroll')) {
				this.scrollbar.setScrollPosition({
					scrollLeft: this.tabsContainer.scrollLeft // during DND the  container gets scrolled so we need to update the custom scrollbar
				});
			}
		}));

		// New file when double clicking on tabs container (but not tabs)
		this._register(addDisposableListener(this.tabsContainer, EventType.DBLCLICK, e => {
			const target = e.target;
			if (target instanceof HTMLElement && target.className.indexOf('tabs-container') === 0) {
				EventHelper.stop(e);

				this.group.openEditor(this.untitledEditorService.createOrGet(), { pinned: true /* untitled is always pinned */, index: this.group.count /* always at the end */ });
			}
		}));

		// Prevent auto-scrolling (https://github.com/Microsoft/vscode/issues/16690)
		this._register(addDisposableListener(this.tabsContainer, EventType.MOUSE_DOWN, (e: MouseEvent) => {
			if (e.button === 1) {
				e.preventDefault();
			}
		}));

		// Custom Scrollbar
		this.scrollbar = new ScrollableElement(this.tabsContainer, {
			horizontal: ScrollbarVisibility.Auto,
			vertical: ScrollbarVisibility.Hidden,
			scrollYToX: true,
			useShadows: false,
			horizontalScrollbarSize: 3
		});

		this.scrollbar.onScroll(e => {
			this.tabsContainer.scrollLeft = e.scrollLeft;
		});

		this.titleContainer.appendChild(this.scrollbar.getDomNode());

		// Drag over
		this._register(addDisposableListener(this.tabsContainer, EventType.DRAG_OVER, (e: DragEvent) => {
			const draggedEditor = this.transfer.hasData(DraggedEditorIdentifier.prototype) ? this.transfer.getData(DraggedEditorIdentifier.prototype)[0].identifier : void 0;

			// update the dropEffect, otherwise it would look like a "move" operation. but only if we are
			// not dragging a tab actually because there we support both moving as well as copying
			if (!draggedEditor) {
				e.dataTransfer.dropEffect = 'copy';
			}

			addClass(this.tabsContainer, 'scroll'); // enable support to scroll while dragging

			const target = e.target;
			if (target instanceof HTMLElement && target.className.indexOf('tabs-container') === 0) {

				// Find out if the currently dragged editor is the last tab of this group and in that
				// case we do not want to show any drop feedback because the drop would be a no-op
				let draggedEditorIsLastTab = false;
				if (draggedEditor && this.group.id === draggedEditor.group.id && this.group.getIndexOfEditor(draggedEditor.editor) === this.group.count - 1) {
					draggedEditorIsLastTab = true;
				}

				if (!draggedEditorIsLastTab) {
					this.updateDropFeedback(this.tabsContainer, true);
				}
			}
		}));

		// Drag leave
		this._register(addDisposableListener(this.tabsContainer, EventType.DRAG_LEAVE, (e: DragEvent) => {
			this.updateDropFeedback(this.tabsContainer, false);
			removeClass(this.tabsContainer, 'scroll');
		}));

		// Drag end
		this._register(addDisposableListener(this.tabsContainer, EventType.DRAG_END, (e: DragEvent) => {
			this.updateDropFeedback(this.tabsContainer, false);
			removeClass(this.tabsContainer, 'scroll');
		}));

		// Drop onto tabs container
		this._register(addDisposableListener(this.tabsContainer, EventType.DROP, (e: DragEvent) => {
			this.updateDropFeedback(this.tabsContainer, false);
			removeClass(this.tabsContainer, 'scroll');

			const target = e.target;
			if (target instanceof HTMLElement && target.className.indexOf('tabs-container') === 0) {
				this.onDrop(e, this.group.count);
			}
		}));

		// Editor Toolbar Container
		this.editorToolbarContainer = document.createElement('div');
		addClass(this.editorToolbarContainer, 'editor-actions');
		this.titleContainer.appendChild(this.editorToolbarContainer);

		// Editor Actions Toolbar
		this.createEditorActionsToolBar(this.editorToolbarContainer);
	}

	private updateDropFeedback(element: HTMLElement, isDND: boolean, index?: number): void {
		const isTab = (typeof index === 'number');
		const isActiveTab = isTab && this.group.isActive(this.group.getEditor(index));

		// Background
		const noDNDBackgroundColor = isTab ? this.getColor(isActiveTab ? TAB_ACTIVE_BACKGROUND : TAB_INACTIVE_BACKGROUND) : null;
		element.style.backgroundColor = isDND ? this.getColor(EDITOR_DRAG_AND_DROP_BACKGROUND) : noDNDBackgroundColor;

		// Outline
		const activeContrastBorderColor = this.getColor(activeContrastBorder);
		if (activeContrastBorderColor && isDND) {
			element.style.outlineWidth = '2px';
			element.style.outlineStyle = 'dashed';
			element.style.outlineColor = activeContrastBorderColor;
			element.style.outlineOffset = isTab ? '-5px' : '-3px';
		} else {
			element.style.outlineWidth = null;
			element.style.outlineStyle = null;
			element.style.outlineColor = activeContrastBorderColor;
			element.style.outlineOffset = null;
		}
	}

	openEditor(editor: IEditorInput): void {
		this.recreate(); // TODO@grid optimize
	}

	closeEditor(editor: IEditorInput): void {
		this.recreate(); // TODO@grid optimize
	}

	moveEditor(editor: IEditorInput, targetIndex: number): void {
		this.recreate(); // TODO@grid optimize
	}

	pinEditor(editor: IEditorInput): void {
		this.withTab(editor, (tabContainer, tabLabelWidget, tabLabel) => this.redrawLabel(tabLabel, editor, tabContainer, tabLabelWidget));
	}

	setActive(isGroupActive: boolean): void {
		this.forEachTab((editor, index, tabContainer, tabLabelWidget, tabLabel) => {
			this.redrawGroupActive(isGroupActive, editor, tabContainer, tabLabelWidget);
		});

		this.updateEditorActionsToolbar();
	}

	updateEditorLabel(editor: IEditorInput): void {
		this.redraw(true /* labels only */);
	}

	updateEditorDirty(editor: IEditorInput): void {
		this.withTab(editor, tabContainer => this.redrawEditorDirty(editor, tabContainer));
	}

	private withTab(editor: IEditorInput, fn: (tabContainer: HTMLElement, tabLabelWidget: ResourceLabel, tabLabel: IEditorInputLabel) => void): void {
		const editorIndex = this.group.getIndexOfEditor(editor);

		const tabContainer = this.tabsContainer.children[editorIndex] as HTMLElement;
		if (tabContainer) {
			fn(tabContainer, this.tabLabelWidgets[editorIndex], this.tabLabels[editorIndex]);
		}
	}

	private recreate(): void {

		// There are tabs to show
		if (this.group.activeEditor) {

			// Create tabs as needed
			this.createTabs();

			// Redraw tabs
			this.redraw();
		}

		// No tabs to show
		else {
			clearNode(this.tabsContainer);

			this.tabDisposeables = dispose(this.tabDisposeables);
			this.tabLabelWidgets = [];
			this.tabLabels = [];

			this.clearEditorActionsToolbar();
		}
	}

	private createTabs(): void {
		const tabs = this.tabsContainer.children;
		const tabsCount = tabs.length;
		const tabsNeeded = this.group.count;

		// Nothing to do if count did not change
		if (tabsCount === tabsNeeded) {
			return;
		}

		// We need more tabs: create new ones
		if (tabsCount < tabsNeeded) {
			for (let i = tabsCount; i < tabsNeeded; i++) {
				this.tabsContainer.appendChild(this.createTab(i));
			}
		}

		// We need less tabs: delete the ones we do not need
		else {
			for (let i = 0; i < tabsCount - tabsNeeded; i++) {
				(this.tabsContainer.lastChild as HTMLElement).remove();
				this.tabLabelWidgets.pop();
				this.tabDisposeables.pop().dispose();
			}
		}
	}

	private createTab(index: number): HTMLElement {

		// Tab Container
		const tabContainer = document.createElement('div');
		tabContainer.draggable = true;
		tabContainer.tabIndex = 0;
		tabContainer.setAttribute('role', 'presentation'); // cannot use role "tab" here due to https://github.com/Microsoft/vscode/issues/8659
		addClass(tabContainer, 'tab');

		// Gesture Support
		Gesture.addTarget(tabContainer);

		// Tab Editor Label
		const editorLabel = this.instantiationService.createInstance(ResourceLabel, tabContainer, void 0);
		this.tabLabelWidgets.push(editorLabel);

		// Tab Close
		const tabCloseContainer = document.createElement('div');
		addClass(tabCloseContainer, 'tab-close');
		tabContainer.appendChild(tabCloseContainer);

		const actionRunner = new TabActionRunner(() => this.group.id, index);
		this.tabDisposeables.push(actionRunner);

		const actionBar = new ActionBar(tabCloseContainer, { ariaLabel: localize('araLabelTabActions', "Tab actions"), actionRunner });
		actionBar.push(this.closeOneEditorAction, { icon: true, label: false, keybinding: this.getKeybindingLabel(this.closeOneEditorAction) });
		actionBar.onDidBeforeRun(() => this.blockRevealActiveTabOnce());

		// Eventing
		const eventsDisposable = this.hookTabListeners(tabContainer, index);

		this.tabDisposeables.push(combinedDisposable([eventsDisposable, actionBar, editorLabel]));

		return tabContainer;
	}

	private hookTabListeners(tab: HTMLElement, index: number): IDisposable {
		const disposables: IDisposable[] = [];

		const handleClickOrTouch = (e: MouseEvent | GestureEvent): void => {
			tab.blur();

			if (e instanceof MouseEvent && e.button !== 0) {
				if (e.button === 1) {
					e.preventDefault(); // required to prevent auto-scrolling (https://github.com/Microsoft/vscode/issues/16690)
				}

				return void 0; // only for left mouse click
			}

			if (!this.originatesFromTabActionBar(e)) {
				setTimeout(() => this.group.openEditor(this.group.getEditor(index))); // timeout to keep focus in editor after mouse up
			}

			return void 0;
		};

		const showContextMenu = (e: Event) => {
			EventHelper.stop(e);

			this.onContextMenu(this.group.getEditor(index), e, tab);
		};

		// Open on Click / Touch
		disposables.push(addDisposableListener(tab, EventType.MOUSE_DOWN, (e: MouseEvent) => handleClickOrTouch(e)));
		disposables.push(addDisposableListener(tab, TouchEventType.Tap, (e: GestureEvent) => handleClickOrTouch(e)));

		// Touch Scroll Support
		disposables.push(addDisposableListener(tab, TouchEventType.Change, (e: GestureEvent) => {
			this.scrollbar.setScrollPosition({ scrollLeft: this.scrollbar.getScrollPosition().scrollLeft - e.translationX });
		}));

		// Close on mouse middle click
		disposables.push(addDisposableListener(tab, EventType.MOUSE_UP, (e: MouseEvent) => {
			EventHelper.stop(e);

			tab.blur();

			if (e.button === 1 /* Middle Button*/ && !this.originatesFromTabActionBar(e)) {
				this.blockRevealActiveTabOnce();
				this.closeOneEditorAction.run({ groupId: this.group.id, editorIndex: index });
			}
		}));

		// Context menu on Shift+F10
		disposables.push(addDisposableListener(tab, EventType.KEY_DOWN, (e: KeyboardEvent) => {
			const event = new StandardKeyboardEvent(e);
			if (event.shiftKey && event.keyCode === KeyCode.F10) {
				showContextMenu(e);
			}
		}));

		// Context menu on touch context menu gesture
		disposables.push(addDisposableListener(tab, TouchEventType.Contextmenu, (e: GestureEvent) => {
			showContextMenu(e);
		}));

		// Keyboard accessibility
		disposables.push(addDisposableListener(tab, EventType.KEY_UP, (e: KeyboardEvent) => {
			const event = new StandardKeyboardEvent(e);
			let handled = false;

			// Run action on Enter/Space
			if (event.equals(KeyCode.Enter) || event.equals(KeyCode.Space)) {
				handled = true;
				this.group.openEditor(this.group.getEditor(index));
			}

			// Navigate in editors
			else if ([KeyCode.LeftArrow, KeyCode.RightArrow, KeyCode.UpArrow, KeyCode.DownArrow, KeyCode.Home, KeyCode.End].some(kb => event.equals(kb))) {
				let targetIndex: number;
				if (event.equals(KeyCode.LeftArrow) || event.equals(KeyCode.UpArrow)) {
					targetIndex = index - 1;
				} else if (event.equals(KeyCode.RightArrow) || event.equals(KeyCode.DownArrow)) {
					targetIndex = index + 1;
				} else if (event.equals(KeyCode.Home)) {
					targetIndex = 0;
				} else {
					targetIndex = this.group.count - 1;
				}

				const target = this.group.getEditor(targetIndex);
				if (target) {
					handled = true;
					this.group.openEditor(target, { preserveFocus: true });
					(<HTMLElement>this.tabsContainer.childNodes[targetIndex]).focus();
				}
			}

			if (handled) {
				EventHelper.stop(e, true);
			}

			// moving in the tabs container can have an impact on scrolling position, so we need to update the custom scrollbar
			this.scrollbar.setScrollPosition({
				scrollLeft: this.tabsContainer.scrollLeft
			});
		}));

		// Pin on double click
		disposables.push(addDisposableListener(tab, EventType.DBLCLICK, (e: MouseEvent) => {
			EventHelper.stop(e);

			this.group.pinEditor(this.group.getEditor(index));
		}));

		// Context menu
		disposables.push(addDisposableListener(tab, EventType.CONTEXT_MENU, (e: Event) => {
			EventHelper.stop(e, true);

			this.onContextMenu(this.group.getEditor(index), e, tab);
		}, true /* use capture to fix https://github.com/Microsoft/vscode/issues/19145 */));

		// Drag start
		disposables.push(addDisposableListener(tab, EventType.DRAG_START, (e: DragEvent) => {
			const editor = this.group.getEditor(index);
			this.transfer.setData([new DraggedEditorIdentifier({ editor, group: (<any>this.group /* TODO@grid should be GroupIdentifier or INextEditorGroup */).group })], DraggedEditorIdentifier.prototype);

			e.dataTransfer.effectAllowed = 'copyMove';

			// Apply some datatransfer types to allow for dragging the element outside of the application
			const resource = toResource(editor, { supportSideBySide: true });
			if (resource) {
				this.instantiationService.invokeFunction(fillResourceDataTransfers, [resource], e);
			}

			// Fixes https://github.com/Microsoft/vscode/issues/18733
			addClass(tab, 'dragged');
			scheduleAtNextAnimationFrame(() => removeClass(tab, 'dragged'));
		}));

		// We need to keep track of DRAG_ENTER and DRAG_LEAVE events because a tab is not just a div without children,
		// it contains a label and a close button. HTML gives us DRAG_ENTER and DRAG_LEAVE events when hovering over
		// these children and this can cause flicker of the drop feedback. The workaround is to count the events and only
		// remove the drop feedback when the counter is 0 (see https://github.com/Microsoft/vscode/issues/14470)
		let counter = 0;

		// Drag over
		disposables.push(addDisposableListener(tab, EventType.DRAG_ENTER, (e: DragEvent) => {
			counter++;

			// Find out if the currently dragged editor is this tab and in that
			// case we do not want to show any drop feedback
			let draggedEditorIsTab = false;
			const draggedEditor = this.transfer.hasData(DraggedEditorIdentifier.prototype) ? this.transfer.getData(DraggedEditorIdentifier.prototype)[0].identifier : void 0;
			if (draggedEditor) {
				if (draggedEditor.editor === this.group.getEditor(index) && draggedEditor.group.id === this.group.id) {
					draggedEditorIsTab = true;
				}
			}

			addClass(tab, 'dragged-over');

			if (!draggedEditorIsTab) {
				this.updateDropFeedback(tab, true, index);
			}
		}));

		// Drag leave
		disposables.push(addDisposableListener(tab, EventType.DRAG_LEAVE, (e: DragEvent) => {
			counter--;
			if (counter === 0) {
				removeClass(tab, 'dragged-over');
				this.updateDropFeedback(tab, false, index);
			}
		}));

		// Drag end
		disposables.push(addDisposableListener(tab, EventType.DRAG_END, (e: DragEvent) => {
			counter = 0;
			removeClass(tab, 'dragged-over');
			this.updateDropFeedback(tab, false, index);

			this.transfer.clearData();
		}));

		// Drop
		disposables.push(addDisposableListener(tab, EventType.DROP, (e: DragEvent) => {
			counter = 0;
			removeClass(tab, 'dragged-over');
			this.updateDropFeedback(tab, false, index);

			this.onDrop(e, index);
		}));

		return combinedDisposable(disposables);
	}

	protected redraw(labelsOnly?: boolean): void {

		// Compute labels and protect against duplicates
		this.tabLabels = this.getTabLabels(this.group.editors);

		// For each tab
		this.forEachTab((editor, index, tabContainer, tabLabelWidget, tabLabel) => {

			// Redraw Label
			this.redrawLabel(tabLabel, editor, tabContainer, tabLabelWidget);

			// Redraw other Styles
			if (!labelsOnly) {

				// Borders
				tabContainer.style.borderLeftColor = (index !== 0) ? (this.getColor(TAB_BORDER) || this.getColor(contrastBorder)) : null;
				tabContainer.style.borderRightColor = (index === this.group.count - 1) ? (this.getColor(TAB_BORDER) || this.getColor(contrastBorder)) : null;
				tabContainer.style.outlineColor = this.getColor(activeContrastBorder);

				// Settings
				const tabOptions = {} as IEditorTabOptions; // TODO@grid support tab options (this.editorGroupService.getTabOptions());

				['off', 'left', 'right'].forEach(option => {
					const domAction = tabOptions.tabCloseButton === option ? addClass : removeClass;
					domAction(tabContainer, `close-button-${option}`);
				});

				['fit', 'shrink'].forEach(option => {
					const domAction = tabOptions.tabSizing === option ? addClass : removeClass;
					domAction(tabContainer, `sizing-${option}`);
				});

				if (tabOptions.showIcons && !!tabOptions.iconTheme) {
					addClass(tabContainer, 'has-icon-theme');
				} else {
					removeClass(tabContainer, 'has-icon-theme');
				}

				// Active state (editor)
				if (this.group.activeEditor === editor) {
					addClass(tabContainer, 'active');
					tabContainer.setAttribute('aria-selected', 'true');
					tabContainer.style.backgroundColor = this.getColor(TAB_ACTIVE_BACKGROUND);

					this.activeTab = tabContainer;
				} else {
					removeClass(tabContainer, 'active');
					tabContainer.setAttribute('aria-selected', 'false');
					tabContainer.style.backgroundColor = this.getColor(TAB_INACTIVE_BACKGROUND);
					tabContainer.style.boxShadow = null;
				}

				// Active state (group)
				this.redrawGroupActive(this.groupsAccessor.activeGroup === this.group, editor, tabContainer, tabLabelWidget);

				// Dirty State
				this.redrawEditorDirty(editor, tabContainer);
			}
		});

		// Update Editor Actions Toolbar
		if (!labelsOnly) {
			this.updateEditorActionsToolbar();
		}

		// Ensure the active tab is always revealed
		this.layout(this.dimension);
	}

	private forEachTab(fn: (editor: IEditorInput, index: number, tabContainer: HTMLElement, tabLabelWidget: ResourceLabel, tabLabel: IEditorInputLabel) => void): void {
		this.group.editors.forEach((editor, index) => {
			const tabContainer = this.tabsContainer.children[index] as HTMLElement;
			if (tabContainer) {
				fn(editor, index, tabContainer, this.tabLabelWidgets[index], this.tabLabels[index]);
			}
		});
	}

	private getTabLabels(editors: IEditorInput[]): IEditorInputLabel[] {
		const labelFormat = 'default'; // TODO@grid support tab options (this.editorGroupService.getTabOptions().labelFormat);
		const { verbosity, shortenDuplicates } = this.getLabelConfigFlags(labelFormat);

		// Build labels and descriptions for each editor
		const labels = editors.map(editor => ({
			editor,
			name: editor.getName(),
			description: editor.getDescription(verbosity),
			title: editor.getTitle(Verbosity.LONG)
		}));

		// Shorten labels as needed
		if (shortenDuplicates) {
			this.shortenTabLabels(labels);
		}

		return labels;
	}

	private shortenTabLabels(labels: AugmentedLabel[]): void {

		// Gather duplicate titles, while filtering out invalid descriptions
		const mapTitleToDuplicates = new Map<string, AugmentedLabel[]>();
		for (const label of labels) {
			if (typeof label.description === 'string') {
				getOrSet(mapTitleToDuplicates, label.name, []).push(label);
			} else {
				label.description = '';
			}
		}

		// Identify duplicate titles and shorten descriptions
		mapTitleToDuplicates.forEach(duplicateTitles => {

			// Remove description if the title isn't duplicated
			if (duplicateTitles.length === 1) {
				duplicateTitles[0].description = '';

				return;
			}

			// Identify duplicate descriptions
			const mapDescriptionToDuplicates = new Map<string, AugmentedLabel[]>();
			for (const label of duplicateTitles) {
				getOrSet(mapDescriptionToDuplicates, label.description, []).push(label);
			}

			// For editors with duplicate descriptions, check whether any long descriptions differ
			let useLongDescriptions = false;
			mapDescriptionToDuplicates.forEach((duplicateDescriptions, name) => {
				if (!useLongDescriptions && duplicateDescriptions.length > 1) {
					const [first, ...rest] = duplicateDescriptions.map(({ editor }) => editor.getDescription(Verbosity.LONG));
					useLongDescriptions = rest.some(description => description !== first);
				}
			});

			// If so, replace all descriptions with long descriptions
			if (useLongDescriptions) {
				mapDescriptionToDuplicates.clear();
				duplicateTitles.forEach(label => {
					label.description = label.editor.getDescription(Verbosity.LONG);
					getOrSet(mapDescriptionToDuplicates, label.description, []).push(label);
				});
			}

			// Obtain final set of descriptions
			const descriptions: string[] = [];
			mapDescriptionToDuplicates.forEach((_, description) => descriptions.push(description));

			// Remove description if all descriptions are identical
			if (descriptions.length === 1) {
				for (const label of mapDescriptionToDuplicates.get(descriptions[0])) {
					label.description = '';
				}

				return;
			}

			// Shorten descriptions
			const shortenedDescriptions = shorten(descriptions);
			descriptions.forEach((description, i) => {
				for (const label of mapDescriptionToDuplicates.get(description)) {
					label.description = shortenedDescriptions[i];
				}
			});
		});
	}

	private getLabelConfigFlags(value: string) {
		switch (value) {
			case 'short':
				return { verbosity: Verbosity.SHORT, shortenDuplicates: false };
			case 'medium':
				return { verbosity: Verbosity.MEDIUM, shortenDuplicates: false };
			case 'long':
				return { verbosity: Verbosity.LONG, shortenDuplicates: false };
			default:
				return { verbosity: Verbosity.MEDIUM, shortenDuplicates: true };
		}
	}

	private redrawLabel(label: IEditorInputLabel, editor: IEditorInput, tabContainer: HTMLElement, tabLabel: ResourceLabel): void {
		const name = label.name;
		const description = label.description || '';
		const title = label.title || '';

		// Container
		tabContainer.setAttribute('aria-label', `${name}, tab`);
		tabContainer.title = title;

		// Label
		tabLabel.setLabel({ name, description, resource: toResource(editor, { supportSideBySide: true }) }, { extraClasses: ['tab-label'], italic: !this.group.isPinned(editor) });
	}

	private redrawGroupActive(isGroupActive: boolean, editor: IEditorInput, tabContainer: HTMLElement, tabLabel: ResourceLabel): void {
		if (this.group.activeEditor === editor) {
			tabLabel.element.style.color = this.getColor(isGroupActive ? TAB_ACTIVE_FOREGROUND : TAB_UNFOCUSED_ACTIVE_FOREGROUND);

			// Use boxShadow for the active tab border because if we also have a editor group header
			// color, the two colors would collide and the tab border never shows up.
			// see https://github.com/Microsoft/vscode/issues/33111
			const activeTabBorderColor = this.getColor(isGroupActive ? TAB_ACTIVE_BORDER : TAB_UNFOCUSED_ACTIVE_BORDER);
			if (activeTabBorderColor) {
				tabContainer.style.boxShadow = `${activeTabBorderColor} 0 -1px inset`;
			} else {
				tabContainer.style.boxShadow = null;
			}
		} else {
			tabLabel.element.style.color = this.getColor(isGroupActive ? TAB_INACTIVE_FOREGROUND : TAB_UNFOCUSED_INACTIVE_FOREGROUND);
		}
	}

	private redrawEditorDirty(editor: IEditorInput, tabContainer: HTMLElement): void {
		if (editor.isDirty()) {
			addClass(tabContainer, 'dirty');
		} else {
			removeClass(tabContainer, 'dirty');
		}
	}

	layout(dimension: Dimension): void {
		if (!this.activeTab || !dimension) {
			return;
		}

		this.dimension = dimension;

		// The layout of tabs can be an expensive operation because we access DOM properties
		// that can result in the browser doing a full page layout to validate them. To buffer
		// this a little bit we try at least to schedule this work on the next animation frame.
		if (!this.layoutScheduled) {
			this.layoutScheduled = scheduleAtNextAnimationFrame(() => {
				this.doLayout(this.dimension);
				this.layoutScheduled = void 0;
			});
		}
	}

	private doLayout(dimension: Dimension): void {
		const visibleContainerWidth = this.tabsContainer.offsetWidth;
		const totalContainerWidth = this.tabsContainer.scrollWidth;

		let activeTabPosX: number;
		let activeTabWidth: number;

		if (!this.blockRevealActiveTab) {
			activeTabPosX = this.activeTab.offsetLeft;
			activeTabWidth = this.activeTab.offsetWidth;
		}

		// Update scrollbar
		this.scrollbar.setScrollDimensions({
			width: visibleContainerWidth,
			scrollWidth: totalContainerWidth
		});

		// Return now if we are blocked to reveal the active tab and clear flag
		if (this.blockRevealActiveTab) {
			this.blockRevealActiveTab = false;
			return;
		}

		// Reveal the active one
		const containerScrollPosX = this.scrollbar.getScrollPosition().scrollLeft;
		const activeTabFits = activeTabWidth <= visibleContainerWidth;

		// Tab is overflowing to the right: Scroll minimally until the element is fully visible to the right
		// Note: only try to do this if we actually have enough width to give to show the tab fully!
		if (activeTabFits && containerScrollPosX + visibleContainerWidth < activeTabPosX + activeTabWidth) {
			this.scrollbar.setScrollPosition({
				scrollLeft: containerScrollPosX + ((activeTabPosX + activeTabWidth) /* right corner of tab */ - (containerScrollPosX + visibleContainerWidth) /* right corner of view port */)
			});
		}

		// Tab is overlflowng to the left or does not fit: Scroll it into view to the left
		else if (containerScrollPosX > activeTabPosX || !activeTabFits) {
			this.scrollbar.setScrollPosition({
				scrollLeft: activeTabPosX
			});
		}
	}

	private blockRevealActiveTabOnce(): void {

		// When closing tabs through the tab close button or gesture, the user 
		// might want to rapidly close tabs in sequence and as such revealing 
		// the active tab after each close would be annoying. As such we block 
		// the automated revealing of the active tab once after the close is 
		// triggered.
		this.blockRevealActiveTab = true;
	}

	private originatesFromTabActionBar(event: MouseEvent | GestureEvent): boolean {
		let element: HTMLElement;
		if (event instanceof MouseEvent) {
			element = (event.target || event.srcElement) as HTMLElement;
		} else {
			element = (event as GestureEvent).initialTarget as HTMLElement;
		}

		return !!findParentWithClass(element, 'monaco-action-bar', 'tab');
	}

	private onDrop(e: DragEvent, targetIndex: number): void {
		EventHelper.stop(e, true);

		this.updateDropFeedback(this.tabsContainer, false);
		removeClass(this.tabsContainer, 'scroll');

		// Local DND
		const draggedEditor = this.transfer.hasData(DraggedEditorIdentifier.prototype) ? this.transfer.getData(DraggedEditorIdentifier.prototype)[0].identifier : void 0;
		if (draggedEditor) {

			// Move editor to target position and index
			if (this.isMoveOperation(e, draggedEditor.group)) {
				const sourceGroup = this.groupsAccessor.getGroup(draggedEditor.group.id) as INextEditorGroup;
				sourceGroup.moveEditor(draggedEditor.editor, this.group, { index: targetIndex });
			}

			// Copy: just open editor at target index
			else {
				this.group.openEditor(draggedEditor.editor, { pinned: true, index: targetIndex });
			}

			this.transfer.clearData();
		}

		// External DND
		else {
			const dropHandler = this.instantiationService.createInstance(ResourcesDropHandler, { allowWorkspaceOpen: false /* open workspace file as file if dropped */ });
			dropHandler.handleDrop(e, () => this.group.focus(), this.group.id /* TODO@grid position => group id */, targetIndex);
		}
	}

	private isMoveOperation(e: DragEvent, source: IEditorGroup) {
		const isCopy = (e.ctrlKey && !isMacintosh) || (e.altKey && isMacintosh);

		return !isCopy || source.id === this.group.id;
	}

	dispose(): void {
		super.dispose();

		this.layoutScheduled = dispose(this.layoutScheduled);
	}
}

class TabActionRunner extends ActionRunner {

	constructor(
		private groupId: () => GroupIdentifier,
		private index: number
	) {
		super();
	}

	run(action: IAction, context?: any): TPromise<void> {
		const groupId = this.groupId();
		if (typeof groupId !== 'number') {
			return TPromise.as(void 0);
		}

		return super.run(action, { groupId, editorIndex: this.index });
	}
}

registerThemingParticipant((theme: ITheme, collector: ICssStyleCollector) => {

	// Styling with Outline color (e.g. high contrast theme)
	const activeContrastBorderColor = theme.getColor(activeContrastBorder);
	if (activeContrastBorderColor) {
		collector.addRule(`
			.monaco-workbench > .part.editor > .content .editor-group-container > .title .tabs-container > .tab.active,
			.monaco-workbench > .part.editor > .content .editor-group-container > .title .tabs-container > .tab.active:hover  {
				outline: 1px solid;
				outline-offset: -5px;
			}

			.monaco-workbench > .part.editor > .content .editor-group-container > .title .tabs-container > .tab:hover  {
				outline: 1px dashed;
				outline-offset: -5px;
			}

			.monaco-workbench > .part.editor > .content .editor-group-container > .title .tabs-container > .tab.active > .tab-close .action-label,
			.monaco-workbench > .part.editor > .content .editor-group-container > .title .tabs-container > .tab.active:hover > .tab-close .action-label,
			.monaco-workbench > .part.editor > .content .editor-group-container > .title .tabs-container > .tab.dirty > .tab-close .action-label,
			.monaco-workbench > .part.editor > .content .editor-group-container > .title .tabs-container > .tab:hover > .tab-close .action-label {
				opacity: 1 !important;
			}
		`);
	}

	// Hover Background
	const tabHoverBackground = theme.getColor(TAB_HOVER_BACKGROUND);
	if (tabHoverBackground) {
		collector.addRule(`
			.monaco-workbench > .part.editor > .content .editor-group-container > .title.active .tabs-container > .tab:hover  {
				background-color: ${tabHoverBackground} !important;
			}
		`);
	}

	const tabUnfocusedHoverBackground = theme.getColor(TAB_UNFOCUSED_HOVER_BACKGROUND);
	if (tabUnfocusedHoverBackground) {
		collector.addRule(`
			.monaco-workbench > .part.editor > .content .editor-group-container > .title.inactive .tabs-container > .tab:hover  {
				background-color: ${tabUnfocusedHoverBackground} !important;
			}
		`);
	}

	// Hover Border
	const tabHoverBorder = theme.getColor(TAB_HOVER_BORDER);
	if (tabHoverBorder) {
		collector.addRule(`
			.monaco-workbench > .part.editor > .content .editor-group-container > .title.active .tabs-container > .tab:hover  {
				box-shadow: ${tabHoverBorder} 0 -1px inset !important;
			}
		`);
	}

	const tabUnfocusedHoverBorder = theme.getColor(TAB_UNFOCUSED_HOVER_BORDER);
	if (tabUnfocusedHoverBorder) {
		collector.addRule(`
			.monaco-workbench > .part.editor > .content .editor-group-container > .title.inactive .tabs-container > .tab:hover  {
				box-shadow: ${tabUnfocusedHoverBorder} 0 -1px inset !important;
			}
		`);
	}

	// Fade out styles via linear gradient (when tabs are set to shrink)
	if (theme.type !== 'hc') {
		const workbenchBackground = WORKBENCH_BACKGROUND(theme);
		const editorBackgroundColor = theme.getColor(editorBackground);
		const editorGroupBackground = theme.getColor(EDITOR_GROUP_BACKGROUND);
		const editorGroupHeaderTabsBackground = theme.getColor(EDITOR_GROUP_HEADER_TABS_BACKGROUND);
		const editorDragAndDropBackground = theme.getColor(EDITOR_DRAG_AND_DROP_BACKGROUND);

		let adjustedTabBackground: Color;
		if (editorGroupHeaderTabsBackground && editorBackgroundColor && editorGroupBackground) {
			adjustedTabBackground = editorGroupHeaderTabsBackground.flatten(editorBackgroundColor, editorGroupBackground, editorBackgroundColor, workbenchBackground);
		}

		let adjustedTabDragBackground: Color;
		if (editorGroupHeaderTabsBackground && editorBackgroundColor && editorDragAndDropBackground && editorBackgroundColor) {
			adjustedTabDragBackground = editorGroupHeaderTabsBackground.flatten(editorBackgroundColor, editorDragAndDropBackground, editorBackgroundColor, workbenchBackground);
		}

		// Adjust gradient for (focused) hover background
		if (tabHoverBackground && adjustedTabBackground && adjustedTabDragBackground) {
			const adjustedColor = tabHoverBackground.flatten(adjustedTabBackground);
			const adjustedColorDrag = tabHoverBackground.flatten(adjustedTabDragBackground);
			collector.addRule(`
				.monaco-workbench > .part.editor > .content:not(.dragged-over) .editor-group-container > .title.active .tabs-container > .tab.sizing-shrink:not(.dragged):hover > .tab-label::after {
					background: linear-gradient(to left, ${adjustedColor}, transparent);
				}


				.monaco-workbench > .part.editor > .content.dragged-over .editor-group-container > .title.active .tabs-container > .tab.sizing-shrink:not(.dragged):hover > .tab-label::after {
					background: linear-gradient(to left, ${adjustedColorDrag}, transparent);
				}
			`);
		}

		// Adjust gradient for unfocused hover background
		if (tabUnfocusedHoverBackground && adjustedTabBackground && adjustedTabDragBackground) {
			const adjustedColor = tabUnfocusedHoverBackground.flatten(adjustedTabBackground);
			const adjustedColorDrag = tabUnfocusedHoverBackground.flatten(adjustedTabDragBackground);
			collector.addRule(`
				.monaco-workbench > .part.editor > .content:not(.dragged-over) .editor-group-container > .title.inactive .tabs-container > .tab.sizing-shrink:not(.dragged):hover > .tab-label::after {
					background: linear-gradient(to left, ${adjustedColor}, transparent);
				}

				.monaco-workbench > .part.editor > .content.dragged-over .editor-group-container > .title.inactive .tabs-container > .tab.sizing-shrink:not(.dragged):hover > .tab-label::after {
					background: linear-gradient(to left, ${adjustedColorDrag}, transparent);
				}
			`);
		}

		// Adjust gradient for drag and drop background
		if (editorDragAndDropBackground && adjustedTabDragBackground) {
			const adjustedColorDrag = editorDragAndDropBackground.flatten(adjustedTabDragBackground);
			collector.addRule(`
			.monaco-workbench > .part.editor > .content.dragged-over .editor-group-container > .title.active .tabs-container > .tab.sizing-shrink.dragged-over:not(.active):not(.dragged) > .tab-label::after,
			.monaco-workbench > .part.editor > .content.dragged-over .editor-group-container > .title.inactive .tabs-container > .tab.sizing-shrink.dragged-over:not(.dragged) > .tab-label::after {
				background: linear-gradient(to left, ${adjustedColorDrag}, transparent);
			}
		`);
		}

		// Adjust gradient for active tab background
		const tabActiveBackground = theme.getColor(TAB_ACTIVE_BACKGROUND);
		if (tabActiveBackground && adjustedTabBackground && adjustedTabDragBackground) {
			const adjustedColor = tabActiveBackground.flatten(adjustedTabBackground);
			const adjustedColorDrag = tabActiveBackground.flatten(adjustedTabDragBackground);
			collector.addRule(`
				.monaco-workbench > .part.editor > .content:not(.dragged-over) .editor-group-container > .title .tabs-container > .tab.sizing-shrink.active:not(.dragged) > .tab-label::after {
					background: linear-gradient(to left, ${adjustedColor}, transparent);
				}

				.monaco-workbench > .part.editor > .content.dragged-over .editor-group-container > .title .tabs-container > .tab.sizing-shrink.active:not(.dragged) > .tab-label::after {
					background: linear-gradient(to left, ${adjustedColorDrag}, transparent);
				}
			`);
		}

		// Adjust gradient for inactive tab background
		const tabInactiveBackground = theme.getColor(TAB_INACTIVE_BACKGROUND);
		if (tabInactiveBackground && adjustedTabBackground && adjustedTabDragBackground) {
			const adjustedColor = tabInactiveBackground.flatten(adjustedTabBackground);
			const adjustedColorDrag = tabInactiveBackground.flatten(adjustedTabDragBackground);
			collector.addRule(`
			.monaco-workbench > .part.editor > .content .editor-group-container > .title
			.monaco-workbench > .part.editor > .content:not(.dragged-over) .editor-group-container > .title .tabs-container > .tab.sizing-shrink:not(.dragged) > .tab-label::after {
				background: linear-gradient(to left, ${adjustedColor}, transparent);
			}

			.monaco-workbench > .part.editor > .content.dragged-over .editor-group-container > .title .tabs-container > .tab.sizing-shrink:not(.dragged) > .tab-label::after {
				background: linear-gradient(to left, ${adjustedColorDrag}, transparent);
			}
		`);
		}
	}
});