// const {UserModel1} = require('../models/userModel');
const Sequelize = require('sequelize');
const { sequelize } = require('../servicenow-models/sequelize');
const initModels = require('../servicenow-models/init-models');
const models = initModels(sequelize);
const Op = require('sequelize').Op;


async function saveUserInfo(userObj, accessToken, hostname, companyId) {
    try {

        let id = userObj.id;
        //Check Current user exist or not
        const existingUser = await models.customer.findOne({
            where: {
                [Op.and]: [
                    {
                        id,
                    }
                ]
            }
        });
        //if current user exists just do nothing 
        if (existingUser) {
            const updateUser = await UserModel1.update({
                status: 1
            },
                {
                    where: {
                        id: id
                    }
                })
        }
        else {
            const createUser = await models.customer.create({
                sysId: userObj.id,
                firstname: userObj.first_name,
                lastname: userObj.last_name,
                email: userObj.email,
                companyId: companyId,
                accessToken: accessToken,
                hostname: hostname
            })
        }
    } catch (error) {
        return error
    }
}

exports.saveUserInfo = saveUserInfo;