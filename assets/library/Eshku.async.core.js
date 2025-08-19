const loadCSSAsync = async href => {
	return new Promise((resolve, reject) => {
		const link = document.createElement('link')
		link.rel = 'stylesheet'
		link.href = href

		document.head.appendChild(link)

		link.onload = () => {
			resolve(`CSS loaded: ${href}`)
		}
		link.onerror = () => {
			reject(new Error(`Failed to load CSS: ${href}`))
		}
	})
}
