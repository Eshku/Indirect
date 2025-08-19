const { UILayoutService } = await import(`${PATH_SERVICES}/UI/UILayoutService.js`)

const STYLE = {
	MAX_WIDTH: 350,
	PADDING: 15,
	BORDER_RADIUS: 5,

	// --- Layout ---
	STATS_LINE_HEIGHT: 22,
	DESCRIPTION_LINE_HEIGHT: 20,
	FORMULA_LINE_HEIGHT: 22,

	// --- Colors ---
	BACKGROUND_COLOR: 0x111111,
	BACKGROUND_ALPHA: 0.9,
	BORDER_COLOR: 0x555555,
	TITLE_COLOR: 0xffd700, // Gold
	DESCRIPTION_COLOR: 0xcccccc,
	DESCRIPTION_HIGHLIGHT_COLOR: 0xffffff,
	STATS_LABEL_COLOR: 0xffffff, // Light grey for labels
	STATS_VALUE_COLOR: 0xffffff, // White for values
	FORMULA_LABEL_COLOR: 0xcccccc, // Grey for secondary info
	FORMULA_VALUE_COLOR: 0xcccccc,

	// --- Fonts ---
	FONT_FAMILY: 'Arial, sans-serif', // A default font family for the tooltip.

	// --- Font Sizes ---
	TITLE_FONT_SIZE: 18,
	DESCRIPTION_FONT_SIZE: 14,
	STATS_FONT_SIZE: 14,
	FORMULA_FONT_SIZE: 14,

	// --- Font Styles & Weights ---
	// Note: fontStyle can be 'normal', 'italic', or 'oblique'.
	// Note: fontWeight can be 'normal', 'bold', 'bolder', 'lighter', or a number string '100'-'900'.
	TITLE_FONT_WEIGHT: 'bold',
	TITLE_FONT_STYLE: 'normal',

	DESCRIPTION_FONT_WEIGHT: 'normal',
	DESCRIPTION_FONT_STYLE: 'normal',

	DESCRIPTION_HIGHLIGHT_WEIGHT: 'bold',
	DESCRIPTION_HIGHLIGHT_FONT_STYLE: 'normal',

	STATS_FONT_WEIGHT: 'normal',
	STATS_FONT_STYLE: 'normal',

	FORMULA_FONT_WEIGHT: 'normal',
	FORMULA_FONT_STYLE: 'normal',
}

/**
 * A UI class that renders a tooltip. It takes a structured "view model"
 * and displays it, handling its own layout and positioning.
 * This specific implementation is for displaying item details.
 */
export class ItemTooltip {
	constructor(pixiApp, layer) {
		this.pixiApp = pixiApp
		this.layer = layer

		this.layoutService = new UILayoutService()

		this.container = new PIXI.Container()
		this.container.visible = false
		this.layer.addChild(this.container)

		this.background = new PIXI.Graphics()
		this.container.addChild(this.background)

		this.titleText = new PIXI.Text('', {
			fontFamily: STYLE.FONT_FAMILY,
			fontSize: STYLE.TITLE_FONT_SIZE,
			fill: STYLE.TITLE_COLOR,
			fontWeight: STYLE.TITLE_FONT_WEIGHT,
			fontStyle: STYLE.TITLE_FONT_STYLE,
		})
		this.titleText.position.set(STYLE.PADDING, STYLE.PADDING)
		this.container.addChild(this.titleText)

		this.descriptionSeparator = new PIXI.Graphics()
		this.container.addChild(this.descriptionSeparator)

		this.descriptionContainer = new PIXI.Container()
		this.container.addChild(this.descriptionContainer)

		this.descTextStyle = new PIXI.TextStyle({
			fontFamily: STYLE.FONT_FAMILY,
			fontSize: STYLE.DESCRIPTION_FONT_SIZE,
			fill: STYLE.DESCRIPTION_COLOR,
			lineHeight: STYLE.DESCRIPTION_LINE_HEIGHT,
			fontWeight: STYLE.DESCRIPTION_FONT_WEIGHT,
			fontStyle: STYLE.DESCRIPTION_FONT_STYLE,
		})

		this.descHighlightTextStyle = new PIXI.TextStyle({
			fontFamily: STYLE.FONT_FAMILY,
			fontSize: STYLE.DESCRIPTION_FONT_SIZE,
			fill: STYLE.DESCRIPTION_HIGHLIGHT_COLOR,
			fontWeight: STYLE.DESCRIPTION_HIGHLIGHT_WEIGHT,
			fontStyle: STYLE.DESCRIPTION_HIGHLIGHT_FONT_STYLE,
			lineHeight: STYLE.DESCRIPTION_LINE_HEIGHT,
		})

		// Create shared text styles to avoid creating them on every update.
		this.statsLabelStyle = new PIXI.TextStyle({
			fontFamily: STYLE.FONT_FAMILY,
			fontSize: STYLE.STATS_FONT_SIZE,
			fill: STYLE.STATS_LABEL_COLOR,
			fontWeight: STYLE.STATS_FONT_WEIGHT,
			fontStyle: STYLE.STATS_FONT_STYLE,
		})
		this.statsValueStyle = new PIXI.TextStyle({
			fontFamily: STYLE.FONT_FAMILY,
			fontSize: STYLE.STATS_FONT_SIZE,
			fill: STYLE.STATS_VALUE_COLOR,
			fontWeight: STYLE.STATS_FONT_WEIGHT,
			fontStyle: STYLE.STATS_FONT_STYLE,
		})
		this.formulaLabelStyle = new PIXI.TextStyle({
			fontFamily: STYLE.FONT_FAMILY,
			fontSize: STYLE.FORMULA_FONT_SIZE,
			fill: STYLE.FORMULA_LABEL_COLOR,
			fontStyle: STYLE.FORMULA_FONT_STYLE,
			fontWeight: STYLE.FORMULA_FONT_WEIGHT,
		})
		this.formulaValueStyle = new PIXI.TextStyle({
			fontFamily: STYLE.FONT_FAMILY,
			fontSize: STYLE.FORMULA_FONT_SIZE,
			fill: STYLE.FORMULA_VALUE_COLOR,
			fontStyle: STYLE.FORMULA_FONT_STYLE,
			fontWeight: STYLE.FORMULA_FONT_WEIGHT,
		})

		this.statsContainer = new PIXI.Container()
		this.container.addChild(this.statsContainer)

		this.statsSeparator = new PIXI.Graphics()
		this.container.addChild(this.statsSeparator)

		this.formulasContainer = new PIXI.Container()
		this.container.addChild(this.formulasContainer)
	}

	update(viewModel) {
		// 1. Populate all content containers first. This calculates their heights.
		this.titleText.text = viewModel.title
		this._updateDescription(viewModel.description)
		this._updateStatsLayout(viewModel.stats)
		this._updateFormulasLayout(viewModel.formulas)

		// 2. Now, position everything sequentially based on their calculated heights.
		let yOffset = this.titleText.y + this.titleText.height

		const hasDescription = viewModel.description?.length > 0
		const hasStats = viewModel.stats?.length > 0

		if (hasDescription) {
			yOffset += STYLE.PADDING
			this.descriptionContainer.position.set(STYLE.PADDING, yOffset)
			yOffset += this.descriptionContainer.height
		}

		// Separator between description and stats
		if (hasDescription && hasStats) {
			yOffset += STYLE.PADDING / 2
			this.descriptionSeparator.clear()
			this.descriptionSeparator
				.moveTo(0, 0)
				.lineTo(STYLE.MAX_WIDTH - STYLE.PADDING * 2, 0)
				.stroke({ width: 1, color: STYLE.BORDER_COLOR })
			this.descriptionSeparator.position.set(STYLE.PADDING, yOffset)
			this.descriptionSeparator.visible = true
			yOffset += STYLE.PADDING / 2
		} else {
			this.descriptionSeparator.visible = false
		}

		if (hasStats) {
			// If there's no description, we still need padding above stats.
			if (!hasDescription) {
				yOffset += STYLE.PADDING
			}
			this.statsContainer.position.set(STYLE.PADDING, yOffset)
			yOffset += viewModel.stats.length * STYLE.STATS_LINE_HEIGHT
		}

		const hasFormulas = viewModel.formulas?.length > 0

		// Position the separator (if needed) and the formulas container.
		if (hasFormulas) {
			// If there are stats, we need a separator with padding.
			if (hasStats) {
				yOffset += STYLE.PADDING / 2 // Space above separator
				this.statsSeparator.clear()
				this.statsSeparator
					.moveTo(0, 0)
					.lineTo(STYLE.MAX_WIDTH - STYLE.PADDING * 2, 0)
					.stroke({ width: 1, color: STYLE.BORDER_COLOR })
				this.statsSeparator.position.set(STYLE.PADDING, yOffset)
				this.statsSeparator.visible = true
				yOffset += STYLE.PADDING / 2 // Space below separator
			} else {
				// If no stats, just add the standard padding above formulas.
				yOffset += STYLE.PADDING
				this.statsSeparator.visible = false
			}

			this.formulasContainer.position.set(STYLE.PADDING, yOffset)
			yOffset += viewModel.formulas.length * STYLE.FORMULA_LINE_HEIGHT
		} else {
			// No formulas, so no separator.
			this.statsSeparator.visible = false
		}

		// 3. Draw the background to fit all the content.
		const finalHeight = Math.max(yOffset + STYLE.PADDING, this.titleText.y + this.titleText.height + STYLE.PADDING * 2)
		this._drawBackground(finalHeight)
	}

	_updateStatsLayout(stats) {
		if (!stats || !stats.length) {
			this.statsContainer.removeChildren()
			return
		}

		this.layoutService.applySpaceBetweenLayout(this.statsContainer, stats, {
			labelStyle: this.statsLabelStyle,
			valueStyle: this.statsValueStyle,
			lineWidth: STYLE.MAX_WIDTH - STYLE.PADDING * 2,
			lineHeight: STYLE.STATS_LINE_HEIGHT,
		})
	}

	_updateFormulasLayout(formulas) {
		if (!formulas || !formulas.length) {
			this.formulasContainer.removeChildren()
			return
		}

		// Use the same space-between layout for formulas.
		// This also handles removing the ":" between label and value.
		this.layoutService.applySpaceBetweenLayout(this.formulasContainer, formulas, {
			labelStyle: this.formulaLabelStyle,
			valueStyle: this.formulaValueStyle,
			lineWidth: STYLE.MAX_WIDTH - STYLE.PADDING * 2,
			lineHeight: STYLE.FORMULA_LINE_HEIGHT,
		})
	}

	_updateDescription(descriptionParts) {
		this.descriptionContainer.removeChildren()
		if (!descriptionParts || !descriptionParts.length) {
			return
		}

		const wordWrapWidth = STYLE.MAX_WIDTH - STYLE.PADDING * 2
		const allTokens = []

		// 1. Tokenize the input into a flat list of words, spaces, and newlines
		for (const part of descriptionParts) {
			const style = part.type === 'dynamic' ? this.descHighlightTextStyle : this.descTextStyle
			// Split by space or newline, but keep the delimiter
			const tokens = part.value.split(/(\s+|\n)/)
			for (const token of tokens) {
				if (token) {
					// filter out empty strings
					allTokens.push({ text: token, style })
				}
			}
		}

		const lines = []
		let currentLine = []
		let currentX = 0

		// 2. Arrange tokens into lines, handling word wrapping and newlines
		for (const token of allTokens) {
			// Handle explicit newlines
			if (token.text === '\n') {
				lines.push(currentLine)
				lines.push([]) // Represents the newline itself for spacing
				currentLine = []
				currentX = 0
				continue
			}

			const isSpace = token.text.match(/^\s+$/)

			// Don't start a line with a space
			if (!currentLine.length && isSpace) {
				continue
			}

			const metrics = PIXI.CanvasTextMetrics.measureText(token.text, token.style)

			// Word wrap to the next line
			if (currentLine.length > 0 && currentX + metrics.width > wordWrapWidth) {
				lines.push(currentLine)
				currentLine = []
				currentX = 0
				// If the new token is a space, skip it as it's now at the start of a new line
				if (isSpace) {
					continue
				}
			}

			currentLine.push(token)
			currentX += metrics.width
		}
		if (currentLine.length > 0) {
			lines.push(currentLine)
		}

		// 3. Render the lines, grouping same-styled tokens for efficiency
		let currentY = 0
		const baseLineHeight = this.descTextStyle.lineHeight

		for (const line of lines) {
			// Handle empty lines, which are our paragraph breaks
			if (line.length === 0) {
				currentY += baseLineHeight * 0.5 // Add some space for paragraph breaks
				continue
			}

			let currentXOnLine = 0
			let maxLineHeight = 0
			const textObjectsOnLine = []

			// Group consecutive tokens of the same style to reduce PIXI.Text objects
			const groupedLine = []
			if (line.length > 0) {
				let currentGroup = { text: line[0].text, style: line[0].style }
				for (let i = 1; i < line.length; i++) {
					if (line[i].style === currentGroup.style) {
						currentGroup.text += line[i].text
					} else {
						groupedLine.push(currentGroup)
						currentGroup = { text: line[i].text, style: line[i].style }
					}
				}
				groupedLine.push(currentGroup)
			}

			// Create PIXI.Text objects for the line and find max height
			for (const segment of groupedLine) {
				const text = new PIXI.Text(segment.text, segment.style)
				text.position.x = currentXOnLine
				textObjectsOnLine.push(text)
				maxLineHeight = Math.max(maxLineHeight, text.height)
				currentXOnLine += text.width
			}

			// Position and add children for the line using the calculated max height
			for (const textObj of textObjectsOnLine) {
				textObj.y = currentY
				this.descriptionContainer.addChild(textObj)
			}

			currentY += maxLineHeight || baseLineHeight
		}
	}

	_drawBackground(height) {
		const width = STYLE.MAX_WIDTH

		this.background.clear()
		this.background.beginFill(STYLE.BACKGROUND_COLOR, STYLE.BACKGROUND_ALPHA)
		this.background.lineStyle(1, STYLE.BORDER_COLOR, 1)
		this.background.drawRoundedRect(0, 0, width, height, STYLE.BORDER_RADIUS)
		this.background.endFill()
	}

	show() {
		if (!this.container) return
		this.container.visible = true
		this.container.alpha = 1.0 // Ensure it's fully visible when shown
		// Bring to front to ensure it's on top of other UI
		this.layer.removeChild(this.container)
		this.layer.addChild(this.container)
	}

	hide() {
		if (!this.container) return
		this.container.visible = false
	}

	setAlpha(alpha) {
		if (this.container) {
			this.container.alpha = alpha
		}
	}

	setPosition(x, y) {
		// Position tooltip centered above the given (x, y) coordinates (which should be the top-center of the icon).
		const screenWidth = this.pixiApp.screen.width
		const tooltipWidth = this.container.width
		const tooltipHeight = this.container.height
		const margin = STYLE.PADDING // Margin from the icon

		let newX = x - tooltipWidth / 2
		let newY = y - tooltipHeight - margin

		// --- Screen edge detection ---
		// Prevent tooltip from going off the left side
		if (newX < 0) {
			newX = 0
		}
		// Prevent tooltip from going off the right side
		if (newX + tooltipWidth > screenWidth) {
			newX = screenWidth - tooltipWidth
		}
		// Prevent tooltip from going off the top side
		if (newY < 0) {
			newY = 0
		}

		this.container.position.set(Math.round(newX), Math.round(newY))
	}

	destroy() {
		this.layer.removeChild(this.container)
		this.container.destroy({ children: true })
	}
}
