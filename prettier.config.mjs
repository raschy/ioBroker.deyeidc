// iobroker prettier configuration file
import prettierConfig from '@iobroker/eslint-config/prettier.config.mjs';

export default {
	//...prettierConfig,
	// uncomment next line if you prefer double quotes
	// singleQuote: false,
	printWidth: 120,
	semi: true,
	tabWidth: 4,
	useTabs: true,
	trailingComma: 'all',
	singleQuote: true,
	singleAttributePerLine: true,
	endOfLine: 'lf',
	bracketSpacing: true,
	arrowParens: 'avoid',
	quoteProps: 'as-needed',
}