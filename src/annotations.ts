import * as core from '@actions/core'
import {File, PMDReport, Violation} from './pmd'
import parser from 'fast-xml-parser'
import fs from 'fs'
import * as path from 'path'
import {Annotation, AnnotationLevel} from './github'
import {chain, map} from 'ramda'
import decode from 'unescape'

export interface LineFilter {
  [filePath: string]: number[] | null
}

const XML_PARSE_OPTIONS = {
  allowBooleanAttributes: true,
  ignoreAttributes: false,
  attributeNamePrefix: ''
}

function asArray<T>(arg: T[] | T | undefined): T[] {
  return !arg ? [] : Array.isArray(arg) ? arg : [arg]
}

function getWarningLevel(arg: string | number): AnnotationLevel {
  switch (arg) {
    case '1':
      return AnnotationLevel.failure
    case '2':
    case '3':
      return AnnotationLevel.warning
    default:
      return AnnotationLevel.notice
  }
}

export function loadLineFilter(lineFilterPath: string): LineFilter | null {
  try {
    const trimmedLineFilterPath = lineFilterPath.trim()
    if (!trimmedLineFilterPath || trimmedLineFilterPath === '') {
      return null
    }

    let lineFilter: LineFilter

    // Check if input contains braces, indicating it's a JSON string
    if (
      trimmedLineFilterPath.startsWith('{') &&
      trimmedLineFilterPath.endsWith('}')
    ) {
      // Parse as JSON string directly
      lineFilter = JSON.parse(trimmedLineFilterPath) as LineFilter
    } else {
      // Parse as file path
      const fullPath = path.resolve(lineFilterPath)
      if (!fs.existsSync(fullPath)) {
        core.warning(`Line filter file not found: ${fullPath}`)
        return null
      }

      const content = fs.readFileSync(fullPath, 'utf-8')
      lineFilter = JSON.parse(content) as LineFilter
    }

    // Validate the line filter format
    if (typeof lineFilter !== 'object' || lineFilter === null) {
      core.warning('Invalid line filter format: must be an object')
      return null
    }

    if (Object.keys(lineFilter).length === 0) {
      core.info('Line filter is empty, no filtering will be applied')
      return null
    }

    // Validate each entry
    for (const [filePath, lines] of Object.entries(lineFilter)) {
      if (
        lines !== null &&
        (!Array.isArray(lines) ||
          !lines.every(line => Number.isInteger(line) && line > 0))
      ) {
        core.warning(
          `Invalid line filter for file ${filePath}: must be an array of positive integers or null`
        )
        return null
      }
    }

    core.info(`Loaded line filter with ${Object.keys(lineFilter).length} files`)
    return lineFilter
  } catch (error) {
    core.warning(`Failed to load line filter: ${error}`)
    return null
  }
}

function shouldIncludeViolation(
  violation: Violation,
  relativeFilePath: string,
  lineFilter: LineFilter
): boolean {
  const filterLines = lineFilter[relativeFilePath]
  // If filterLines is null, allow all violations for this file
  if (filterLines === null) {
    return true
  }
  if (!filterLines) {
    return false
  }

  const beginLine = Number(violation.beginline || 1)
  const endLine = Number(violation.endline || violation.beginline || 1)

  return filterLines.some(line => line >= beginLine && line <= endLine)
}

export function annotationsForPath(
  resultFile: string,
  lineFilter?: LineFilter | null
): Annotation[] {
  core.info(`Creating annotations for ${resultFile}`)
  const root: string = process.env['GITHUB_WORKSPACE'] || ''

  const result: PMDReport = parser.parse(
    fs.readFileSync(resultFile, <const>'UTF-8'),
    XML_PARSE_OPTIONS
  )

  return chain(file => {
    const relativeFilePath = path.relative(root, file.name)

    return map(violation => {
      // If line filter is provided, check if violation should be included
      if (
        lineFilter &&
        !shouldIncludeViolation(violation, relativeFilePath, lineFilter)
      ) {
        return null
      }

      const annotation: Annotation = {
        annotation_level: getWarningLevel(violation.priority),
        path: relativeFilePath,
        start_line: Number(violation.beginline || 1),
        end_line: Number(violation.endline || violation.beginline || 1),
        title: `${violation.ruleset} ${violation.rule}`,
        message: decode(violation['#text'])
      }

      return annotation
    }, asArray(file.violation)).filter(
      (annotation): annotation is Annotation => annotation !== null
    )
  }, asArray<File>(result.pmd?.file))
}
