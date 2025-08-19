/**
 * @fileoverview A reusable service for applying common layout patterns to PIXI.Containers.
 */

/**
 * A service for applying common layout patterns to PIXI.Containers.
 * This helps to centralize layout logic and keep UI components cleaner.
 */
export class UILayoutService {
	/**
	 * Populates a container with rows of label-value pairs, creating a "space-between" effect.
	 * It clears the container before adding new text objects.
	 *
	 * @param {PIXI.Container} container - The container to populate.
	 * @param {Array<{label: string, value: string}>} rows - The data for each row.
	 * @param {object} options - Styling and layout options.
	 * @param {PIXI.TextStyle} options.labelStyle - The style for the label text.
	 * @param {PIXI.TextStyle} options.valueStyle - The style for the value text.
	 * @param {number} options.lineWidth - The total width for the content.
	 * @param {number} options.lineHeight - The vertical space for each row.
	 */
	applySpaceBetweenLayout(container, rows, { labelStyle, valueStyle, lineWidth, lineHeight }) {
		container.removeChildren()
		if (!rows || rows.length === 0) {
			// The caller is responsible for reading the container's height after this.
			// A container with no children will have a height of 0.
			return
		}

		let currentY = 0
		for (const rowData of rows) {
			const label = new PIXI.Text(rowData.label, labelStyle)
			const value = new PIXI.Text(rowData.value, valueStyle)

			// Vertically center text within the line height for a cleaner look.
			label.position.set(0, currentY + (lineHeight - label.height) / 2)
			container.addChild(label)

			value.anchor.set(1, 0) // Anchor to top-right
			value.position.set(lineWidth, currentY + (lineHeight - value.height) / 2)
			container.addChild(value)

			currentY += lineHeight
		}
	}

	/**
	 * Populates a container with a two-column layout (right-aligned labels, left-aligned values).
	 * It clears the container before adding new text objects.
	 *
	 * @param {PIXI.Container} container - The container to populate.
	 * @param {Array<{label: string, value: string}>} rows - The data for each row.
	 * @param {object} options - Styling and layout options.
	 * @param {PIXI.TextStyle} options.labelStyle - The style for the label text.
	 * @param {PIXI.TextStyle} options.valueStyle - The style for the value text.
	 * @param {number} options.labelColumnWidth - The width of the label column.
	 * @param {number} options.lineHeight - The vertical space for each row.
	 * @param {number} [options.gutterWidth=10] - The space between columns.
	 */
	applyTwoColumnLayout(container, rows, { labelStyle, valueStyle, labelColumnWidth, lineHeight, gutterWidth = 10 }) {
		container.removeChildren()
		if (!rows || rows.length === 0) {
			return
		}

		let currentY = 0
		for (const rowData of rows) {
			const label = new PIXI.Text(rowData.label, labelStyle)
			const value = new PIXI.Text(rowData.value, valueStyle)

			// Right-aligned labels
			label.anchor.set(1, 0) // Anchor to top-right
			label.position.set(labelColumnWidth, currentY + (lineHeight - label.height) / 2)

			// Left-aligned values
			value.anchor.set(0, 0) // Anchor to top-left
			value.position.set(labelColumnWidth + gutterWidth, currentY + (lineHeight - value.height) / 2)

			container.addChild(label, value)
			currentY += lineHeight
		}
	}
}