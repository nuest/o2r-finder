/*
* (C) Copyright 2017 o2r project
*
* Licensed under the Apache License, Version 2.0 (the "License");
* you may not use this file except in compliance with the License.
* You may obtain a copy of the License at
*
*     http://www.apache.org/licenses/LICENSE-2.0
*
* Unless required by applicable law or agreed to in writing, software
* distributed under the License is distributed on an "AS IS" BASIS,
* WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
* See the License for the specific language governing permissions and
* limitations under the License.
*
*/

const config = require('./config');

const mapping = {
    "compendia": {
        "properties": {
            "_special": {
                "type": "string",
                "analyzer": config.elasticsearch.analyzer
            },
            "metadata": {
                "properties": {
                    "o2r": {
                        "properties": {
                            "spatial": {
                                "properties": {
                                    "union": {
                                        "properties": {
                                            "geojson": {
                                                "properties": {
                                                    "geometry": {
                                                        "type": "geo_shape",
                                                        "tree": "quadtree"
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }
                            },
                            "identifier": {
                                "properties": {
                                    "doi": {
                                        "type": "string",
                                        "copy_to": config.elasticsearch.specialCharField
                                    },
                                    "doiurl": {
                                        "type": "string",
                                        "copy_to": config.elasticsearch.specialCharField
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
};

module.exports = {
    mapping: mapping
};